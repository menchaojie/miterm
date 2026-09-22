//! TCP 服务：每连接一线程；多 session 可同时 attach（按 session_id 路由输出）。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use parking_lot::Mutex;

use crate::protocol::{decode_b64, encode_b64, ClientMsg, ServerMsg};
use crate::session::{PtyEvent, SessionManager};

struct ActiveAttach {
    writer: Mutex<TcpStream>,
}

type AttachMap = HashMap<String, Arc<ActiveAttach>>;

pub struct AgentServer {
    token: String,
    sessions: Arc<SessionManager>,
    /// session_id → 当前 attach 的 TCP 写出端（多分屏并行）
    attaches: Arc<Mutex<AttachMap>>,
    running: Arc<AtomicBool>,
}

impl AgentServer {
    pub fn new(token: String, sessions: Arc<SessionManager>, events: Receiver<PtyEvent>) -> Self {
        let attaches: Arc<Mutex<AttachMap>> = Arc::new(Mutex::new(HashMap::new()));
        let running = Arc::new(AtomicBool::new(true));

        let sessions_ev = Arc::clone(&sessions);
        let attaches_ev = Arc::clone(&attaches);
        let running_ev = Arc::clone(&running);
        thread::spawn(move || {
            while running_ev.load(Ordering::SeqCst) {
                match events.recv_timeout(Duration::from_millis(500)) {
                    Ok(PtyEvent::Output { session_id, data }) => {
                        sessions_ev.on_output(&session_id, &data);
                        let target = attaches_ev.lock().get(&session_id).cloned();
                        if let Some(a) = target {
                            let msg = ServerMsg::Output {
                                data: encode_b64(&data),
                            };
                            let _ = send_line(&a.writer, &msg);
                        }
                    }
                    Ok(PtyEvent::Exited { session_id }) => {
                        sessions_ev.mark_exited(&session_id);
                        let target = attaches_ev.lock().get(&session_id).cloned();
                        if let Some(a) = target {
                            let msg = ServerMsg::Closed {
                                session_id: session_id.clone(),
                                reason: "exited".into(),
                            };
                            let _ = send_line(&a.writer, &msg);
                        }
                        clear_attach(&attaches_ev, &session_id);
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
        });

        Self {
            token,
            sessions,
            attaches,
            running,
        }
    }

    pub fn serve(self: Arc<Self>, listener: TcpListener) {
        for stream in listener.incoming() {
            if !self.running.load(Ordering::SeqCst) {
                break;
            }
            let Ok(stream) = stream else {
                continue;
            };
            let _ = stream.set_nodelay(true);
            let server = Arc::clone(&self);
            thread::spawn(move || server.handle_client(stream));
        }
    }

    fn handle_client(&self, stream: TcpStream) {
        let Ok(reader_stream) = stream.try_clone() else {
            return;
        };
        let writer = Arc::new(Mutex::new(stream));
        let mut reader = BufReader::new(reader_stream);
        let mut line = String::new();
        let mut authed = false;
        let mut attached: Option<String> = None;

        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {}
                Err(_) => break,
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            let msg: ClientMsg = match serde_json::from_str(trimmed) {
                Ok(m) => m,
                Err(e) => {
                    let _ = send_line(
                        &writer,
                        &ServerMsg::Error {
                            message: format!("bad json: {e}"),
                        },
                    );
                    continue;
                }
            };

            if !authed {
                match msg {
                    ClientMsg::Auth { token } => {
                        if token == self.token {
                            authed = true;
                            let _ = send_line(
                                &writer,
                                &ServerMsg::Ok {
                                    message: "authenticated".into(),
                                },
                            );
                        } else {
                            let _ = send_line(
                                &writer,
                                &ServerMsg::Error {
                                    message: "invalid token".into(),
                                },
                            );
                            break;
                        }
                    }
                    _ => {
                        let _ = send_line(
                            &writer,
                            &ServerMsg::Error {
                                message: "auth required".into(),
                            },
                        );
                    }
                }
                continue;
            }

            match msg {
                ClientMsg::Auth { .. } => {
                    let _ = send_line(
                        &writer,
                        &ServerMsg::Ok {
                            message: "already authenticated".into(),
                        },
                    );
                }
                ClientMsg::Ping => {
                    let _ = send_line(&writer, &ServerMsg::Pong);
                }
                ClientMsg::Create {
                    cols,
                    rows,
                    shell,
                    session_id,
                } => match self.sessions.create(
                    cols.unwrap_or(80),
                    rows.unwrap_or(24),
                    shell.as_deref(),
                    session_id.as_deref(),
                ) {
                    Ok(id) => {
                        let _ = send_line(&writer, &ServerMsg::Created { session_id: id });
                    }
                    Err(e) => {
                        let _ = send_line(&writer, &ServerMsg::Error { message: e });
                    }
                },
                ClientMsg::Attach { session_id } => {
                    if let Some(old) = attached.take() {
                        self.sessions.detach(&old);
                        clear_attach(&self.attaches, &old);
                    }
                    match self.sessions.attach(&session_id) {
                        Ok((replay, cols, rows)) => {
                            attached = Some(session_id.clone());
                            if let Ok(w) = writer.lock().try_clone() {
                                self.attaches.lock().insert(
                                    session_id.clone(),
                                    Arc::new(ActiveAttach {
                                        writer: Mutex::new(w),
                                    }),
                                );
                            }
                            let _ = send_line(
                                &writer,
                                &ServerMsg::Attached {
                                    session_id,
                                    replay: encode_b64(&replay),
                                    cols,
                                    rows,
                                },
                            );
                        }
                        Err(e) => {
                            let _ = send_line(&writer, &ServerMsg::Error { message: e });
                        }
                    }
                }
                ClientMsg::Detach => {
                    if let Some(id) = attached.take() {
                        self.sessions.detach(&id);
                        clear_attach(&self.attaches, &id);
                        let _ = send_line(&writer, &ServerMsg::Detached { session_id: id });
                    } else {
                        let _ = send_line(
                            &writer,
                            &ServerMsg::Error {
                                message: "not attached".into(),
                            },
                        );
                    }
                }
                ClientMsg::Input { data } => {
                    let Some(ref id) = attached else {
                        let _ = send_line(
                            &writer,
                            &ServerMsg::Error {
                                message: "not attached".into(),
                            },
                        );
                        continue;
                    };
                    match decode_b64(&data) {
                        Ok(bytes) => {
                            if let Err(e) = self.sessions.write_input(id, &bytes) {
                                let _ = send_line(&writer, &ServerMsg::Error { message: e });
                            }
                        }
                        Err(e) => {
                            let _ = send_line(&writer, &ServerMsg::Error { message: e });
                        }
                    }
                }
                ClientMsg::Resize { cols, rows } => {
                    let Some(ref id) = attached else {
                        let _ = send_line(
                            &writer,
                            &ServerMsg::Error {
                                message: "not attached".into(),
                            },
                        );
                        continue;
                    };
                    if let Err(e) = self.sessions.resize(id, cols, rows) {
                        let _ = send_line(&writer, &ServerMsg::Error { message: e });
                    }
                }
                ClientMsg::List => {
                    self.sessions.reap_dead();
                    let items = self.sessions.list();
                    let _ = send_line(&writer, &ServerMsg::Sessions { items });
                }
                ClientMsg::Kill { session_id } => {
                    if attached.as_deref() == Some(session_id.as_str()) {
                        attached = None;
                        clear_attach(&self.attaches, &session_id);
                    }
                    match self.sessions.kill(&session_id) {
                        Ok(()) => {
                            let _ = send_line(
                                &writer,
                                &ServerMsg::Closed {
                                    session_id,
                                    reason: "killed".into(),
                                },
                            );
                        }
                        Err(e) => {
                            let _ = send_line(&writer, &ServerMsg::Error { message: e });
                        }
                    }
                }
            }
        }

        if let Some(id) = attached.take() {
            self.sessions.detach(&id);
            clear_attach(&self.attaches, &id);
        }
        {
            let w = writer.lock();
            let _ = w.shutdown(Shutdown::Both);
        }
    }
}

fn clear_attach(attaches: &Mutex<AttachMap>, session_id: &str) {
    attaches.lock().remove(session_id);
}

fn send_line(writer: &Mutex<TcpStream>, msg: &ServerMsg) -> Result<(), String> {
    let mut line = serde_json::to_string(msg).map_err(|e| e.to_string())?;
    line.push('\n');
    let mut w = writer.lock();
    w.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    w.flush().map_err(|e| e.to_string())
}
