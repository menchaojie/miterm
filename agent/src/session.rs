//! PTY 会话：客户端断开不杀 shell；重 attach 时回放环形缓冲。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use uuid::Uuid;

use crate::protocol::SessionInfo;

const RING_CAP: usize = 256 * 1024;

pub enum PtyEvent {
    Output { session_id: String, data: Vec<u8> },
    Exited { session_id: String },
}

pub struct SessionManager {
    inner: Mutex<HashMap<String, Session>>,
    event_tx: Sender<PtyEvent>,
}

struct Session {
    id: String,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Box<dyn MasterPty + Send>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    stop: Arc<AtomicBool>,
    reader: Option<JoinHandle<()>>,
    waiter: Option<JoinHandle<()>>,
    ring: Mutex<RingBuffer>,
    cols: u16,
    rows: u16,
    /// 当前是否有客户端 attach（仅允许一个）
    attached: bool,
    alive: bool,
}

struct RingBuffer {
    buf: Vec<u8>,
    cap: usize,
}

impl RingBuffer {
    fn new(cap: usize) -> Self {
        Self {
            buf: Vec::with_capacity(cap.min(64 * 1024)),
            cap,
        }
    }

    fn push(&mut self, data: &[u8]) {
        if data.is_empty() {
            return;
        }
        if data.len() >= self.cap {
            self.buf.clear();
            self.buf.extend_from_slice(&data[data.len() - self.cap..]);
            return;
        }
        let overflow = self.buf.len().saturating_add(data.len()).saturating_sub(self.cap);
        if overflow > 0 {
            self.buf.drain(0..overflow);
        }
        self.buf.extend_from_slice(data);
    }

    fn snapshot(&self) -> Vec<u8> {
        self.buf.clone()
    }
}

impl SessionManager {
    pub fn new() -> (Self, Receiver<PtyEvent>) {
        let (tx, rx) = mpsc::channel();
        (
            Self {
                inner: Mutex::new(HashMap::new()),
                event_tx: tx,
            },
            rx,
        )
    }

    pub fn create(
        &self,
        cols: u16,
        rows: u16,
        shell: Option<&str>,
        preferred_id: Option<&str>,
    ) -> Result<String, String> {
        let id = preferred_id
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| Uuid::new_v4().to_string());

        {
            let map = self.inner.lock();
            if map.contains_key(&id) {
                return Err(format!("session already exists: {id}"));
            }
        }

        let cols = cols.max(1);
        let rows = rows.max(1);
        let (exe, args) = resolve_shell(shell)?;

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("openpty: {e}"))?;

        let mut cmd = CommandBuilder::new(&exe);
        for a in &args {
            cmd.arg(a);
        }
        if let Some(home) = user_home_dir() {
            cmd.cwd(home);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("spawn {exe}: {e}"))?;
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
        let event_tx = self.event_tx.clone();
        let sid_reader = id.clone();
        let stop_reader = Arc::clone(&stop);

        let reader_handle = thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                if stop_reader.load(Ordering::SeqCst) {
                    break;
                }
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let _ = event_tx.send(PtyEvent::Output {
                            session_id: sid_reader.clone(),
                            data: buf[..n].to_vec(),
                        });
                    }
                    Err(_) => break,
                }
            }
            let _ = event_tx.send(PtyEvent::Exited {
                session_id: sid_reader,
            });
        });

        let stop_waiter = Arc::clone(&stop);
        let child_waiter = Arc::clone(&child);
        let sid_waiter = id.clone();
        let event_tx_w = self.event_tx.clone();
        let waiter_handle = thread::spawn(move || {
            loop {
                if stop_waiter.load(Ordering::SeqCst) {
                    break;
                }
                let status = {
                    let mut c = child_waiter.lock();
                    c.try_wait()
                };
                match status {
                    Ok(Some(_)) => {
                        let _ = event_tx_w.send(PtyEvent::Exited {
                            session_id: sid_waiter,
                        });
                        break;
                    }
                    Ok(None) => thread::sleep(Duration::from_millis(200)),
                    Err(_) => {
                        let _ = event_tx_w.send(PtyEvent::Exited {
                            session_id: sid_waiter,
                        });
                        break;
                    }
                }
            }
        });

        let session = Session {
            id: id.clone(),
            writer: Mutex::new(writer),
            master: pair.master,
            child,
            stop,
            reader: Some(reader_handle),
            waiter: Some(waiter_handle),
            ring: Mutex::new(RingBuffer::new(RING_CAP)),
            cols,
            rows,
            attached: false,
            alive: true,
        };

        self.inner.lock().insert(id.clone(), session);
        Ok(id)
    }

    pub fn on_output(&self, session_id: &str, data: &[u8]) {
        if let Some(s) = self.inner.lock().get(session_id) {
            s.ring.lock().push(data);
        }
    }

    pub fn mark_exited(&self, session_id: &str) {
        let mut map = self.inner.lock();
        if let Some(s) = map.get_mut(session_id) {
            s.alive = false;
            s.attached = false;
            s.stop.store(true, Ordering::SeqCst);
        }
    }

    pub fn attach(&self, session_id: &str) -> Result<(Vec<u8>, u16, u16), String> {
        let mut map = self.inner.lock();
        let s = map
            .get_mut(session_id)
            .ok_or_else(|| format!("session not found: {session_id}"))?;
        if !s.alive {
            return Err(format!("session dead: {session_id}"));
        }
        if s.attached {
            return Err(format!("session already attached: {session_id}"));
        }
        s.attached = true;
        let replay = s.ring.lock().snapshot();
        Ok((replay, s.cols, s.rows))
    }

    pub fn detach(&self, session_id: &str) {
        if let Some(s) = self.inner.lock().get_mut(session_id) {
            s.attached = false;
        }
    }

    pub fn write_input(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        let map = self.inner.lock();
        let s = map
            .get(session_id)
            .ok_or_else(|| format!("session not found: {session_id}"))?;
        if !s.alive {
            return Err("session dead".into());
        }
        if !s.attached {
            return Err("not attached".into());
        }
        s.writer
            .lock()
            .write_all(data)
            .map_err(|e| format!("write: {e}"))?;
        s.writer.lock().flush().ok();
        Ok(())
    }

    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let cols = cols.max(1);
        let rows = rows.max(1);
        let mut map = self.inner.lock();
        let s = map
            .get_mut(session_id)
            .ok_or_else(|| format!("session not found: {session_id}"))?;
        if !s.alive {
            return Err("session dead".into());
        }
        s.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("resize: {e}"))?;
        s.cols = cols;
        s.rows = rows;
        Ok(())
    }

    pub fn kill(&self, session_id: &str) -> Result<(), String> {
        let mut map = self.inner.lock();
        let Some(mut s) = map.remove(session_id) else {
            return Err(format!("session not found: {session_id}"));
        };
        s.stop.store(true, Ordering::SeqCst);
        {
            let mut child = s.child.lock();
            let _ = child.kill();
        }
        drop(s.writer);
        drop(s.master);
        if let Some(h) = s.reader.take() {
            let _ = h.join();
        }
        if let Some(h) = s.waiter.take() {
            let _ = h.join();
        }
        Ok(())
    }

    pub fn list(&self) -> Vec<SessionInfo> {
        self.inner
            .lock()
            .values()
            .map(|s| SessionInfo {
                id: s.id.clone(),
                alive: s.alive,
                attached: s.attached,
                cols: s.cols,
                rows: s.rows,
            })
            .collect()
    }

    /// 清理已死会话的句柄（可选，list 时也可惰性清）。
    pub fn reap_dead(&self) {
        let mut map = self.inner.lock();
        let dead: Vec<String> = map
            .iter()
            .filter(|(_, s)| !s.alive)
            .map(|(id, _)| id.clone())
            .collect();
        for id in dead {
            if let Some(mut s) = map.remove(&id) {
                s.stop.store(true, Ordering::SeqCst);
                drop(s.writer);
                drop(s.master);
                if let Some(h) = s.reader.take() {
                    std::mem::forget(h);
                }
                if let Some(h) = s.waiter.take() {
                    std::mem::forget(h);
                }
            }
        }
    }
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

fn resolve_shell(shell: Option<&str>) -> Result<(String, Vec<String>), String> {
    if let Some(path) = shell.map(str::trim).filter(|s| !s.is_empty()) {
        return Ok((path.to_string(), vec![]));
    }

    #[cfg(windows)]
    {
        let comspec = std::env::var("ComSpec").unwrap_or_else(|_| r"C:\Windows\System32\cmd.exe".into());
        Ok((comspec, vec![]))
    }
    #[cfg(not(windows))]
    {
        if let Ok(sh) = std::env::var("SHELL") {
            if !sh.trim().is_empty() {
                return Ok((sh, vec!["-l".into()]));
            }
        }
        for candidate in ["/bin/bash", "/bin/zsh", "/bin/sh"] {
            if PathBuf::from(candidate).is_file() {
                let args = if candidate.ends_with("sh") && !candidate.ends_with("bash") {
                    vec![]
                } else {
                    vec!["-l".into()]
                };
                return Ok((candidate.to_string(), args));
            }
        }
        Err("no shell found ($SHELL /bin/bash)".into())
    }
}
