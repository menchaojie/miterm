mod sftp_ops;

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use socket2::{SockRef, TcpKeepalive};
use ssh2::Session;
use tauri::{AppHandle, Emitter};

pub use sftp_ops::{
    SftpDownloadParams, SftpListParams, SftpListResult, SftpUploadParams,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectParams {
    pub session_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub cols: u32,
    pub rows: u32,
}

#[derive(Clone)]
pub(crate) struct SessionAuth {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshOutputPayload {
    pub session_id: String,
    pub data: Vec<u8>,
}

/// 断开原因：user=主动关 Tab；remote=对端干净关闭（如 exit）；error=异常/网络
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshClosedPayload {
    pub session_id: String,
    pub reason: &'static str,
}

pub struct SshSessionManager {
    sessions: Arc<Mutex<HashMap<String, ActiveSession>>>,
}

struct SharedSsh {
    session: Session,
    channel: ssh2::Channel,
}

struct ActiveSession {
    shared: Arc<Mutex<SharedSsh>>,
    auth: SessionAuth,
    /// 独立 SFTP 连接（与 PTY 分离，避免堵终端）
    sftp: Arc<Mutex<Option<sftp_ops::SftpSideSession>>>,
    stop: Arc<AtomicBool>,
    reader: JoinHandle<()>,
    keepalive: JoinHandle<()>,
}

fn is_temporarily_unavailable(err: &std::io::Error) -> bool {
    matches!(
        err.kind(),
        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
    )
}

fn is_ssh_temporarily_unavailable(err: &ssh2::Error) -> bool {
    use ssh2::ErrorCode;
    matches!(
        err.code(),
        ErrorCode::Session(code) if code == -37 || code == -39
    )
}

pub(crate) fn apply_tcp_keepalive(tcp: &TcpStream) -> Result<(), String> {
    let sock = SockRef::from(tcp);
    sock.set_keepalive(true)
        .map_err(|e| format!("set_keepalive: {e}"))?;
    let ka = TcpKeepalive::new()
        .with_time(Duration::from_secs(30))
        .with_interval(Duration::from_secs(10));
    sock.set_tcp_keepalive(&ka)
        .map_err(|e| format!("set_tcp_keepalive: {e}"))?;
    Ok(())
}

fn write_shared(shared: &Arc<Mutex<SharedSsh>>, data: &[u8]) -> Result<(), String> {
    let mut written = 0;
    while written < data.len() {
        let result = {
            let mut guard = shared.lock();
            guard.channel.write(&data[written..])
        };
        match result {
            Ok(0) => return Err("write returned 0".into()),
            Ok(n) => written += n,
            Err(e) if is_temporarily_unavailable(&e) => {
                thread::sleep(Duration::from_millis(5));
            }
            Err(e) => return Err(format!("write failed: {e}")),
        }
    }

    loop {
        let result = {
            let mut guard = shared.lock();
            guard.channel.flush()
        };
        match result {
            Ok(()) => break,
            Err(e) if is_temporarily_unavailable(&e) => {
                thread::sleep(Duration::from_millis(5));
            }
            Err(e) => return Err(format!("flush failed: {e}")),
        }
    }
    Ok(())
}

fn teardown_session(active: ActiveSession) {
    active.stop.store(true, Ordering::SeqCst);
    {
        let mut slot = active.sftp.lock();
        *slot = None;
    }

    if let Some(mut guard) = active.shared.try_lock() {
        let _ = guard.channel.close();
        let _ = guard.session.disconnect(None, "", None);
    }

    let _ = active.reader.join();
    let _ = active.keepalive.join();
}

impl SshSessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn has_session(&self, session_id: &str) -> bool {
        self.sessions.lock().contains_key(session_id)
    }

    pub fn disconnect(&self, app: &AppHandle, session_id: &str, notify: bool) {
        let active = self.sessions.lock().remove(session_id);
        let had_session = active.is_some();

        if let Some(active) = active {
            teardown_session(active);
        }

        if notify && had_session {
            let _ = app.emit(
                "ssh-closed",
                SshClosedPayload {
                    session_id: session_id.to_string(),
                    reason: "user",
                },
            );
        }
    }

    pub fn connect(&self, app: AppHandle, params: ConnectParams) -> Result<String, String> {
        let session_id = params.session_id.trim().to_string();
        if session_id.is_empty() {
            return Err("sessionId is required".into());
        }

        if let Some(old) = self.sessions.lock().remove(&session_id) {
            teardown_session(old);
        }

        let ConnectParams {
            session_id: _,
            host,
            port,
            username,
            password,
            cols,
            rows,
        } = params;

        let auth = SessionAuth {
            host: host.clone(),
            port,
            username: username.clone(),
            password: password.clone(),
        };

        let tcp = TcpStream::connect((host.as_str(), port))
            .map_err(|e| format!("TCP connect failed: {e}"))?;
        if let Err(e) = apply_tcp_keepalive(&tcp) {
            eprintln!("[ssh] tcp keepalive: {e}");
        }

        let mut sess = Session::new().map_err(|e| format!("session: {e}"))?;
        sess.set_tcp_stream(tcp);
        sess.handshake()
            .map_err(|e| format!("handshake: {e}"))?;
        sess.userauth_password(&username, &password)
            .map_err(|e| format!("authentication failed: {e}"))?;

        if !sess.authenticated() {
            return Err("authentication failed".into());
        }

        sess.set_keepalive(true, 15);

        let mut channel = sess
            .channel_session()
            .map_err(|e| format!("channel: {e}"))?;
        channel
            .request_pty("xterm-256color", None, Some((cols, rows, 0, 0)))
            .map_err(|e| format!("request_pty: {e}"))?;
        let _ = channel.setenv(
            "PROMPT_COMMAND",
            r#"printf '\033]7;file://%s\007' "$PWD""#,
        );
        channel.shell().map_err(|e| format!("shell: {e}"))?;

        sess.set_blocking(false);

        let shared = Arc::new(Mutex::new(SharedSsh {
            session: sess,
            channel,
        }));
        let sftp = Arc::new(Mutex::new(None));
        let stop = Arc::new(AtomicBool::new(false));
        let sessions_map = Arc::clone(&self.sessions);

        let stop_reader = Arc::clone(&stop);
        let shared_reader = Arc::clone(&shared);
        let app_reader = app.clone();
        let session_id_reader = session_id.clone();
        let sessions_reader = Arc::clone(&sessions_map);

        let reader = thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut close_reason: Option<&'static str> = None;
            loop {
                if stop_reader.load(Ordering::SeqCst) {
                    break;
                }

                let read_result = {
                    let mut guard = shared_reader.lock();
                    guard.channel.read(&mut buf)
                };

                match read_result {
                    Ok(0) => {
                        close_reason = Some("remote");
                        break;
                    }
                    Ok(n) => {
                        if stop_reader.load(Ordering::SeqCst) {
                            break;
                        }
                        let payload = SshOutputPayload {
                            session_id: session_id_reader.clone(),
                            data: buf[..n].to_vec(),
                        };
                        if app_reader.emit("ssh-output", payload).is_err() {
                            close_reason = Some("error");
                            break;
                        }
                    }
                    Err(e) if is_temporarily_unavailable(&e) => {
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(_) => {
                        close_reason = Some("error");
                        break;
                    }
                }
            }

            if let Some(reason) = close_reason {
                let removed = sessions_reader.lock().remove(&session_id_reader);
                if let Some(active) = removed {
                    active.stop.store(true, Ordering::SeqCst);
                    {
                        let mut slot = active.sftp.lock();
                        *slot = None;
                    }
                    std::mem::forget(active.reader);
                    let _ = active.keepalive.join();
                    if let Some(mut guard) = active.shared.try_lock() {
                        let _ = guard.channel.close();
                    }
                }
                let _ = app_reader.emit(
                    "ssh-closed",
                    SshClosedPayload {
                        session_id: session_id_reader,
                        reason,
                    },
                );
            }
        });

        let stop_ka = Arc::clone(&stop);
        let shared_ka = Arc::clone(&shared);
        let keepalive = thread::spawn(move || {
            while !stop_ka.load(Ordering::SeqCst) {
                for _ in 0..50 {
                    if stop_ka.load(Ordering::SeqCst) {
                        return;
                    }
                    thread::sleep(Duration::from_millis(100));
                }
                if stop_ka.load(Ordering::SeqCst) {
                    break;
                }
                let result = {
                    let guard = shared_ka.lock();
                    guard.session.keepalive_send()
                };
                if result.is_err() {
                    break;
                }
            }
        });

        self.sessions.lock().insert(
            session_id.clone(),
            ActiveSession {
                shared,
                auth,
                sftp,
                stop,
                reader,
                keepalive,
            },
        );

        Ok(session_id)
    }

    pub fn write(&self, session_id: &str, data: Vec<u8>) -> Result<(), String> {
        let shared = {
            let guard = self.sessions.lock();
            guard
                .get(session_id)
                .map(|active| Arc::clone(&active.shared))
                .ok_or_else(|| "not connected".to_string())?
        };

        write_shared(&shared, &data)
    }

    pub fn resize(&self, session_id: &str, cols: u32, rows: u32) -> Result<(), String> {
        let shared = {
            let guard = self.sessions.lock();
            guard
                .get(session_id)
                .map(|active| Arc::clone(&active.shared))
                .ok_or_else(|| "not connected".to_string())?
        };

        loop {
            let result = {
                let mut guard = shared.lock();
                guard.channel.request_pty_size(cols, rows, None, None)
            };
            match result {
                Ok(()) => return Ok(()),
                Err(e) => {
                    if is_ssh_temporarily_unavailable(&e) {
                        thread::sleep(Duration::from_millis(5));
                    } else {
                        return Err(format!("resize failed: {e}"));
                    }
                }
            }
        }
    }

    fn sftp_handles(
        &self,
        session_id: &str,
    ) -> Result<(SessionAuth, Arc<Mutex<Option<sftp_ops::SftpSideSession>>>), String> {
        let guard = self.sessions.lock();
        let active = guard
            .get(session_id)
            .ok_or_else(|| "not connected".to_string())?;
        Ok((active.auth.clone(), Arc::clone(&active.sftp)))
    }

    pub fn sftp_list(&self, session_id: &str, path: &str) -> Result<SftpListResult, String> {
        let (auth, slot) = self.sftp_handles(session_id)?;
        let mut guard = sftp_ops::ensure_sftp(&slot, &auth)?;
        let result = {
            let side = guard.as_ref().ok_or_else(|| "SFTP not ready".to_string())?;
            sftp_ops::list_dir(side, path)
        };
        if result.is_err() {
            *guard = None;
        }
        result
    }

    pub fn sftp_upload(
        &self,
        app: &AppHandle,
        session_id: &str,
        remote_dir: &str,
    ) -> Result<Option<String>, String> {
        let local = match sftp_ops::pick_local_file()? {
            Some(p) => p,
            None => return Ok(None),
        };
        let (auth, slot) = self.sftp_handles(session_id)?;
        let mut guard = sftp_ops::ensure_sftp(&slot, &auth)?;
        let result = {
            let side = guard.as_ref().ok_or_else(|| "SFTP not ready".to_string())?;
            sftp_ops::upload_file(app, session_id, side, remote_dir, &local).map(Some)
        };
        if result.is_err() {
            *guard = None;
        }
        result
    }

    pub fn sftp_download(
        &self,
        app: &AppHandle,
        session_id: &str,
        remote_path: &str,
    ) -> Result<Option<String>, String> {
        let name = sftp_ops::file_name_of(remote_path);
        let local = match sftp_ops::pick_save_path(&name)? {
            Some(p) => p,
            None => return Ok(None),
        };
        let (auth, slot) = self.sftp_handles(session_id)?;
        let mut guard = sftp_ops::ensure_sftp(&slot, &auth)?;
        let result = {
            let side = guard.as_ref().ok_or_else(|| "SFTP not ready".to_string())?;
            sftp_ops::download_file(app, session_id, side, remote_path, &local)
                .map(|()| Some(local.to_string_lossy().into_owned()))
        };
        if result.is_err() {
            *guard = None;
        }
        result
    }

    pub fn sftp_download_dir(
        &self,
        app: &AppHandle,
        session_id: &str,
        remote_path: &str,
    ) -> Result<Option<String>, String> {
        let parent = match sftp_ops::pick_folder()? {
            Some(p) => p,
            None => return Ok(None),
        };
        let (auth, slot) = self.sftp_handles(session_id)?;
        let mut guard = sftp_ops::ensure_sftp(&slot, &auth)?;
        let result = {
            let side = guard.as_ref().ok_or_else(|| "SFTP not ready".to_string())?;
            sftp_ops::download_dir(app, session_id, side, remote_path, &parent).map(Some)
        };
        if result.is_err() {
            *guard = None;
        }
        result
    }
}
