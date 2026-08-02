use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Deserialize;
use tauri::{AppHandle, Emitter};

use crate::ssh::{SshClosedPayload, SshOutputPayload};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalConnectParams {
    pub session_id: String,
    /// powershell | cmd | gitbash | custom
    pub shell: String,
    pub custom_path: Option<String>,
    pub cols: u32,
    pub rows: u32,
}

pub struct LocalSessionManager {
    sessions: Arc<Mutex<HashMap<String, ActiveLocalSession>>>,
}

struct ActiveLocalSession {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Box<dyn MasterPty + Send>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    stop: Arc<AtomicBool>,
    reader: JoinHandle<()>,
    waiter: JoinHandle<()>,
}

enum CloseOrigin {
    /// 读线程检测到 EOF / 读错误
    Reader,
    /// 等待线程检测到子进程已退出（Windows ConPTY 上更可靠）
    Waiter,
}

fn path_exists(p: &Path) -> bool {
    p.is_file()
}

fn user_home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

fn first_existing(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates.iter().find(|p| path_exists(p)).cloned()
}

fn optional_exe_path(custom_path: Option<&str>) -> Option<PathBuf> {
    custom_path
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

fn resolve_shell(shell: &str, custom_path: Option<&str>) -> Result<(PathBuf, Vec<String>), String> {
    let kind = shell.trim().to_lowercase();
    match kind.as_str() {
        "powershell" => {
            #[cfg(windows)]
            {
                if let Some(path) = optional_exe_path(custom_path) {
                    if !path_exists(&path) {
                        return Err(format!("PowerShell 路径不存在：{}", path.display()));
                    }
                    return Ok((path, vec!["-NoLogo".into()]));
                }
                let candidates = [
                    PathBuf::from(r"C:\Program Files\PowerShell\7\pwsh.exe"),
                    PathBuf::from(r"C:\Program Files\PowerShell\6\pwsh.exe"),
                    PathBuf::from(
                        std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into()),
                    )
                    .join(r"System32\WindowsPowerShell\v1.0\powershell.exe"),
                ];
                let path = first_existing(&candidates).ok_or_else(|| {
                    "未找到 PowerShell（pwsh.exe / powershell.exe）".to_string()
                })?;
                return Ok((path, vec!["-NoLogo".into()]));
            }
            #[cfg(not(windows))]
            {
                let _ = custom_path;
                return Err("当前平台不支持 PowerShell 预设，请用自定义路径或系统 shell".into());
            }
        }
        "cmd" => {
            #[cfg(windows)]
            {
                if let Some(path) = optional_exe_path(custom_path) {
                    if !path_exists(&path) {
                        return Err(format!("cmd 路径不存在：{}", path.display()));
                    }
                    return Ok((path, vec![]));
                }
                let path = PathBuf::from(
                    std::env::var("ComSpec").unwrap_or_else(|_| r"C:\Windows\System32\cmd.exe".into()),
                );
                if !path_exists(&path) {
                    return Err(format!("未找到 cmd：{}", path.display()));
                }
                return Ok((path, vec![]));
            }
            #[cfg(not(windows))]
            {
                return Err("cmd 仅适用于 Windows".into());
            }
        }
        "gitbash" => {
            #[cfg(windows)]
            {
                let args = vec!["--login".into(), "-i".into()];
                if let Some(path) = optional_exe_path(custom_path) {
                    if !path_exists(&path) {
                        return Err(format!("Git Bash 路径不存在：{}", path.display()));
                    }
                    return Ok((path, args));
                }
                let mut candidates = vec![
                    PathBuf::from(r"D:\Program Files\Git\bin\bash.exe"),
                    PathBuf::from(r"C:\Program Files\Git\bin\bash.exe"),
                    PathBuf::from(r"C:\Program Files (x86)\Git\bin\bash.exe"),
                ];
                if let Ok(local) = std::env::var("LOCALAPPDATA") {
                    candidates.push(PathBuf::from(local).join(r"Programs\Git\bin\bash.exe"));
                }
                let path = first_existing(&candidates).ok_or_else(|| {
                    "未找到 Git Bash（bash.exe），请在主机设置中填写路径".to_string()
                })?;
                return Ok((path, args));
            }
            #[cfg(not(windows))]
            {
                return Err("Git Bash 仅适用于 Windows".into());
            }
        }
        "custom" => {
            let path = optional_exe_path(custom_path)
                .ok_or_else(|| "请填写自定义 Shell 路径".to_string())?;
            if !path_exists(&path) {
                return Err(format!("自定义路径不存在：{}", path.display()));
            }
            return Ok((path, vec![]));
        }
        _ => {
            #[cfg(windows)]
            {
                return resolve_shell("powershell", None);
            }
            #[cfg(not(windows))]
            {
                let shell_env = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
                let path = PathBuf::from(&shell_env);
                if !path_exists(&path) {
                    return Err(format!("未找到 shell：{shell_env}"));
                }
                return Ok((path, vec!["-l".into()]));
            }
        }
    }
}

fn teardown(active: ActiveLocalSession) {
    active.stop.store(true, Ordering::SeqCst);
    {
        let mut child = active.child.lock();
        let _ = child.kill();
    }
    drop(active.writer);
    drop(active.master);
    let _ = active.reader.join();
    let _ = active.waiter.join();
}

/// 子进程退出或 PTY 结束后清理会话并通知前端（只成功移除一次，避免重复 emit）。
fn peer_close_session(
    sessions: &Arc<Mutex<HashMap<String, ActiveLocalSession>>>,
    session_id: &str,
    app: &AppHandle,
    origin: CloseOrigin,
) {
    let Some(active) = sessions.lock().remove(session_id) else {
        return;
    };
    active.stop.store(true, Ordering::SeqCst);
    {
        let mut child = active.child.lock();
        let _ = child.kill();
    }
    drop(active.writer);
    drop(active.master);

    match origin {
        CloseOrigin::Reader => {
            // 当前线程就是 reader；waiter 会因 stop / 会话已移除而退出。
            std::mem::forget(active.reader);
            std::mem::forget(active.waiter);
        }
        CloseOrigin::Waiter => {
            let _ = active.reader.join();
            std::mem::forget(active.waiter);
        }
    }

    let _ = app.emit(
        "ssh-closed",
        SshClosedPayload {
            session_id: session_id.to_string(),
            reason: "remote",
        },
    );
}

impl LocalSessionManager {
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
        let had = active.is_some();
        if let Some(active) = active {
            teardown(active);
        }
        if notify && had {
            let _ = app.emit(
                "ssh-closed",
                SshClosedPayload {
                    session_id: session_id.to_string(),
                    reason: "user",
                },
            );
        }
    }

    pub fn connect(&self, app: AppHandle, params: LocalConnectParams) -> Result<String, String> {
        let session_id = params.session_id.trim().to_string();
        if session_id.is_empty() {
            return Err("sessionId is required".into());
        }

        if let Some(old) = self.sessions.lock().remove(&session_id) {
            teardown(old);
        }

        let (exe, args) = resolve_shell(
            &params.shell,
            params.custom_path.as_deref(),
        )?;

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: params.rows.max(1) as u16,
                cols: params.cols.max(1) as u16,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("open pty: {e}"))?;

        let mut cmd = CommandBuilder::new(exe);
        for a in args {
            cmd.arg(a);
        }
        if let Some(home) = user_home_dir() {
            cmd.cwd(home);
        }
        cmd.env("TERM", "xterm-256color");

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("spawn shell: {e}"))?;
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("clone reader: {e}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("take writer: {e}"))?;

        let child = Arc::new(Mutex::new(child));
        let stop = Arc::new(AtomicBool::new(false));
        let stop_reader = Arc::clone(&stop);
        let app_reader = app.clone();
        let session_id_reader = session_id.clone();
        let sessions_reader = Arc::clone(&self.sessions);

        let reader_handle = thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut peer_closed = false;
            loop {
                if stop_reader.load(Ordering::SeqCst) {
                    break;
                }
                match reader.read(&mut buf) {
                    Ok(0) => {
                        peer_closed = true;
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
                            peer_closed = true;
                            break;
                        }
                    }
                    Err(_) => {
                        peer_closed = true;
                        break;
                    }
                }
            }
            if peer_closed {
                peer_close_session(
                    &sessions_reader,
                    &session_id_reader,
                    &app_reader,
                    CloseOrigin::Reader,
                );
            }
        });

        let stop_waiter = Arc::clone(&stop);
        let child_waiter = Arc::clone(&child);
        let sessions_waiter = Arc::clone(&self.sessions);
        let session_id_waiter = session_id.clone();
        let app_waiter = app.clone();

        let waiter_handle = thread::spawn(move || {
            loop {
                if stop_waiter.load(Ordering::SeqCst) {
                    break;
                }
                let exited = {
                    let mut guard = child_waiter.lock();
                    match guard.try_wait() {
                        Ok(Some(_)) => true,
                        Ok(None) => false,
                        Err(_) => true,
                    }
                };
                if exited {
                    // 给读线程一点时间把 logout 等尾部输出推到前端
                    thread::sleep(Duration::from_millis(80));
                    peer_close_session(
                        &sessions_waiter,
                        &session_id_waiter,
                        &app_waiter,
                        CloseOrigin::Waiter,
                    );
                    break;
                }
                thread::sleep(Duration::from_millis(50));
            }
        });

        self.sessions.lock().insert(
            session_id.clone(),
            ActiveLocalSession {
                writer: Mutex::new(writer),
                master: pair.master,
                child,
                stop,
                reader: reader_handle,
                waiter: waiter_handle,
            },
        );

        Ok(session_id)
    }

    pub fn write(&self, session_id: &str, data: Vec<u8>) -> Result<(), String> {
        let guard = self.sessions.lock();
        let active = guard
            .get(session_id)
            .ok_or_else(|| "not connected".to_string())?;
        let mut writer = active.writer.lock();
        writer
            .write_all(&data)
            .map_err(|e| format!("write failed: {e}"))?;
        writer.flush().map_err(|e| format!("flush failed: {e}"))?;
        Ok(())
    }

    pub fn resize(&self, session_id: &str, cols: u32, rows: u32) -> Result<(), String> {
        let guard = self.sessions.lock();
        let active = guard
            .get(session_id)
            .ok_or_else(|| "not connected".to_string())?;
        active
            .master
            .resize(PtySize {
                rows: rows.max(1) as u16,
                cols: cols.max(1) as u16,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("resize failed: {e}"))
    }
}
