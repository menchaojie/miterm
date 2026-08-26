mod sftp_ops;

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use socket2::{SockRef, TcpKeepalive};
use ssh2::{Channel, Session};
use tauri::{AppHandle, Emitter};

pub use sftp_ops::{
    classify_local_paths, ClassifyLocalPathsResult, SftpClassifyPathsParams, SftpDownloadParams,
    SftpListParams, SftpListResult, SftpUploadParams, SftpUploadPathsParams,
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

/// 单会话内所有 libssh2 调用只在 I/O 线程串行执行，避免非阻塞 EAGAIN 交叉调用弄坏会话。
enum IoCmd {
    Write {
        data: Vec<u8>,
        reply: Sender<Result<(), String>>,
    },
    Resize {
        cols: u32,
        rows: u32,
        reply: Sender<Result<(), String>>,
    },
    Stop,
}

struct ActiveSession {
    auth: SessionAuth,
    /// 独立 SFTP 连接（与 PTY 分离，避免堵终端）
    sftp: Arc<Mutex<Option<sftp_ops::SftpSideSession>>>,
    cmd_tx: Sender<IoCmd>,
    io_thread: JoinHandle<()>,
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

fn write_channel(channel: &mut Channel, data: &[u8]) -> Result<(), String> {
    let mut written = 0;
    while written < data.len() {
        match channel.write(&data[written..]) {
            Ok(0) => return Err("write returned 0".into()),
            Ok(n) => written += n,
            Err(e) if is_temporarily_unavailable(&e) => {
                // set_timeout 下可能短暂 TimedOut；同线程重试即可
                thread::sleep(Duration::from_millis(1));
            }
            Err(e) => return Err(format!("write failed: {e}")),
        }
    }

    loop {
        match channel.flush() {
            Ok(()) => return Ok(()),
            Err(e) if is_temporarily_unavailable(&e) => {
                thread::sleep(Duration::from_millis(1));
            }
            Err(e) => return Err(format!("flush failed: {e}")),
        }
    }
}

fn resize_channel(channel: &mut Channel, cols: u32, rows: u32) -> Result<(), String> {
    loop {
        match channel.request_pty_size(cols, rows, None, None) {
            Ok(()) => return Ok(()),
            Err(e) if is_ssh_temporarily_unavailable(&e) => {
                thread::sleep(Duration::from_millis(1));
            }
            Err(e) => return Err(format!("resize failed: {e}")),
        }
    }
}

fn drain_cmds(
    cmd_rx: &Receiver<IoCmd>,
    session: &Session,
    channel: &mut Channel,
) -> bool {
    loop {
        match cmd_rx.try_recv() {
            Ok(IoCmd::Write { data, reply }) => {
                let _ = reply.send(write_channel(channel, &data));
            }
            Ok(IoCmd::Resize { cols, rows, reply }) => {
                let _ = reply.send(resize_channel(channel, cols, rows));
            }
            Ok(IoCmd::Stop) => {
                while let Ok(cmd) = cmd_rx.try_recv() {
                    match cmd {
                        IoCmd::Write { reply, .. } | IoCmd::Resize { reply, .. } => {
                            let _ = reply.send(Err("disconnected".into()));
                        }
                        IoCmd::Stop => {}
                    }
                }
                let _ = channel.close();
                let _ = session.disconnect(None, "", None);
                return true;
            }
            Err(mpsc::TryRecvError::Empty) => return false,
            Err(mpsc::TryRecvError::Disconnected) => return true,
        }
    }
}

fn run_session_io(
    mut session: Session,
    mut channel: Channel,
    cmd_rx: Receiver<IoCmd>,
    app: AppHandle,
    session_id: String,
    sessions: Arc<Mutex<HashMap<String, ActiveSession>>>,
) {
    // 短超时阻塞：读不会永久占死，便于穿插处理写/resize/keepalive；全程同线程串行。
    session.set_blocking(true);
    session.set_timeout(50);

    let mut buf = [0u8; 8192];
    let mut close_reason: Option<&'static str> = None;
    let mut last_ka = Instant::now();

    loop {
        if drain_cmds(&cmd_rx, &session, &mut channel) {
            close_reason = None;
            break;
        }

        if last_ka.elapsed() >= Duration::from_secs(5) {
            match session.keepalive_send() {
                Ok(_) => last_ka = Instant::now(),
                Err(e) => {
                    eprintln!("[ssh] keepalive failed ({session_id}): {e}");
                    close_reason = Some("error");
                    break;
                }
            }
        }

        match channel.read(&mut buf) {
            Ok(0) => {
                close_reason = Some("remote");
                break;
            }
            Ok(n) => {
                let payload = SshOutputPayload {
                    session_id: session_id.clone(),
                    data: buf[..n].to_vec(),
                };
                if app.emit("ssh-output", payload).is_err() {
                    eprintln!("[ssh] emit ssh-output failed ({session_id})");
                    close_reason = Some("error");
                    break;
                }
            }
            Err(e) if is_temporarily_unavailable(&e) => {
                // 正常：无数据 / 超时，继续处理命令
            }
            Err(e) => {
                eprintln!("[ssh] channel read error ({session_id}): {e}");
                close_reason = Some("error");
                break;
            }
        }
    }

    if let Some(reason) = close_reason {
        while let Ok(cmd) = cmd_rx.try_recv() {
            match cmd {
                IoCmd::Write { reply, .. } | IoCmd::Resize { reply, .. } => {
                    let _ = reply.send(Err("disconnected".into()));
                }
                IoCmd::Stop => {}
            }
        }
        let removed = sessions.lock().remove(&session_id);
        if let Some(active) = removed {
            {
                let mut slot = active.sftp.lock();
                *slot = None;
            }
            // 当前就是 I/O 线程，不能 join 自己
            std::mem::forget(active.io_thread);
            drop(active.cmd_tx);
        }
        let _ = channel.close();
        let _ = app.emit(
            "ssh-closed",
            SshClosedPayload {
                session_id,
                reason,
            },
        );
    }
}

fn teardown_session(active: ActiveSession) {
    {
        let mut slot = active.sftp.lock();
        *slot = None;
    }
    let _ = active.cmd_tx.send(IoCmd::Stop);
    let _ = active.io_thread.join();
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

        // want_reply=false：降低对端/中间设备对 keepalive 应答不兼容时的误杀
        sess.set_keepalive(false, 15);

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

        let sftp = Arc::new(Mutex::new(None));
        let sessions_map = Arc::clone(&self.sessions);
        let (cmd_tx, cmd_rx) = mpsc::channel::<IoCmd>();

        let app_io = app.clone();
        let session_id_io = session_id.clone();
        let io_thread = thread::spawn(move || {
            run_session_io(sess, channel, cmd_rx, app_io, session_id_io, sessions_map);
        });

        self.sessions.lock().insert(
            session_id.clone(),
            ActiveSession {
                auth,
                sftp,
                cmd_tx,
                io_thread,
            },
        );

        Ok(session_id)
    }

    pub fn write(&self, session_id: &str, data: Vec<u8>) -> Result<(), String> {
        let (reply_tx, reply_rx) = mpsc::channel();
        {
            let guard = self.sessions.lock();
            let active = guard
                .get(session_id)
                .ok_or_else(|| "not connected".to_string())?;
            active
                .cmd_tx
                .send(IoCmd::Write {
                    data,
                    reply: reply_tx,
                })
                .map_err(|_| "session io stopped".to_string())?;
        }
        reply_rx
            .recv()
            .map_err(|_| "session io stopped".to_string())?
    }

    pub fn resize(&self, session_id: &str, cols: u32, rows: u32) -> Result<(), String> {
        let (reply_tx, reply_rx) = mpsc::channel();
        {
            let guard = self.sessions.lock();
            let active = guard
                .get(session_id)
                .ok_or_else(|| "not connected".to_string())?;
            active
                .cmd_tx
                .send(IoCmd::Resize {
                    cols,
                    rows,
                    reply: reply_tx,
                })
                .map_err(|_| "session io stopped".to_string())?;
        }
        reply_rx
            .recv()
            .map_err(|_| "session io stopped".to_string())?
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

    pub fn sftp_upload_dir(
        &self,
        app: &AppHandle,
        session_id: &str,
        remote_dir: &str,
    ) -> Result<Option<String>, String> {
        let local = match sftp_ops::pick_upload_folder()? {
            Some(p) => p,
            None => return Ok(None),
        };
        let (auth, slot) = self.sftp_handles(session_id)?;
        let mut guard = sftp_ops::ensure_sftp(&slot, &auth)?;
        let result = {
            let side = guard.as_ref().ok_or_else(|| "SFTP not ready".to_string())?;
            sftp_ops::upload_dir(app, session_id, side, remote_dir, &local).map(Some)
        };
        if result.is_err() {
            *guard = None;
        }
        result
    }

    pub fn sftp_upload_paths(
        &self,
        app: &AppHandle,
        session_id: &str,
        remote_dir: &str,
        paths: &[String],
    ) -> Result<String, String> {
        let (auth, slot) = self.sftp_handles(session_id)?;
        let mut guard = sftp_ops::ensure_sftp(&slot, &auth)?;
        let result = {
            let side = guard.as_ref().ok_or_else(|| "SFTP not ready".to_string())?;
            sftp_ops::upload_paths(app, session_id, side, remote_dir, paths)
        };
        if result.is_err() {
            *guard = None;
        }
        result
    }
}
