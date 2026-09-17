//! miterm 远端保活 agent：在 127.0.0.1 上握着 PTY，供本机经 SSH 隧道 attach。

mod protocol;
mod server;
mod session;

use std::env;
use std::fs;
use std::io::{self, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process;
use std::sync::Arc;

use rand::{distributions::Alphanumeric, Rng};

use protocol::{ReadyInfo, AGENT_VERSION, READY_PREFIX};
use server::AgentServer;
use session::SessionManager;

fn main() {
    if let Err(e) = run() {
        eprintln!("miterm-agent error: {e}");
        process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let mut bind_host = "127.0.0.1".to_string();
    let mut bind_port: u16 = 0;
    let mut token: Option<String> = None;
    let mut state_dir: Option<PathBuf> = None;
    let mut probe = false;

    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--help" | "-h" => {
                print_help();
                return Ok(());
            }
            "--version" | "-V" => {
                println!("miterm-agent {AGENT_VERSION}");
                return Ok(());
            }
            "--host" => {
                bind_host = args.next().ok_or("--host needs value")?;
            }
            "--port" => {
                let v = args.next().ok_or("--port needs value")?;
                bind_port = v.parse().map_err(|_| "invalid --port")?;
            }
            "--token" => {
                token = Some(args.next().ok_or("--token needs value")?);
            }
            "--state-dir" => {
                state_dir = Some(PathBuf::from(args.next().ok_or("--state-dir needs value")?));
            }
            "--probe" => {
                probe = true;
            }
            other => return Err(format!("unknown arg: {other}")),
        }
    }

    if probe {
        let dir = state_dir.ok_or("--probe requires --state-dir")?;
        if let Some(existing) = try_reuse_existing(&dir)? {
            emit_ready(&existing)?;
            return Ok(());
        }
        process::exit(2);
    }

    if bind_host != "127.0.0.1" && bind_host != "::1" && bind_host != "localhost" {
        eprintln!(
            "warning: binding to {bind_host} exposes the agent; prefer 127.0.0.1 + SSH tunnel"
        );
    }

    if let Some(dir) = state_dir.as_ref() {
        fs::create_dir_all(dir).map_err(|e| format!("state-dir: {e}"))?;
        if let Some(existing) = try_reuse_existing(dir)? {
            emit_ready(&existing)?;
            // 已有实例在跑：打印 READY 后退出，供 ensure 脚本发现
            return Ok(());
        }
    }

    let token = token.unwrap_or_else(random_token);
    let listener = TcpListener::bind((bind_host.as_str(), bind_port))
        .map_err(|e| format!("bind {bind_host}:{bind_port}: {e}"))?;
    let local = listener
        .local_addr()
        .map_err(|e| format!("local_addr: {e}"))?;

    let ready = ReadyInfo {
        version: AGENT_VERSION.to_string(),
        host: local.ip().to_string(),
        port: local.port(),
        token: token.clone(),
        pid: process::id(),
    };
    if let Some(dir) = state_dir.as_ref() {
        write_state_files(dir, &ready)?;
    }
    emit_ready(&ready)?;
    eprintln!(
        "miterm-agent {AGENT_VERSION} listening on {}:{} (pid {})",
        ready.host, ready.port, ready.pid
    );

    let (sessions, events) = SessionManager::new();
    let sessions = Arc::new(sessions);
    let server = Arc::new(AgentServer::new(token, sessions, events));
    server.serve(listener);
    Ok(())
}

fn try_reuse_existing(dir: &Path) -> Result<Option<ReadyInfo>, String> {
    let ready_path = dir.join("ready.json");
    let Ok(text) = fs::read_to_string(&ready_path) else {
        return Ok(None);
    };
    let info: ReadyInfo =
        serde_json::from_str(text.trim()).map_err(|e| format!("ready.json: {e}"))?;
    if info.version != AGENT_VERSION {
        return Ok(None);
    }
    if !pid_alive(info.pid) {
        return Ok(None);
    }
    Ok(Some(info))
}

fn pid_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        Path::new(&format!("/proc/{pid}")).is_dir()
    }
    #[cfg(windows)]
    {
        let _ = pid;
        false
    }
}

fn write_state_files(dir: &Path, ready: &ReadyInfo) -> Result<(), String> {
    let json = serde_json::to_string(ready).map_err(|e| e.to_string())?;
    fs::write(dir.join("ready.json"), format!("{json}\n")).map_err(|e| e.to_string())?;
    fs::write(dir.join("agent.pid"), format!("{}\n", ready.pid)).map_err(|e| e.to_string())?;
    Ok(())
}

fn emit_ready(ready: &ReadyInfo) -> Result<(), String> {
    let ready_json = serde_json::to_string(ready).map_err(|e| e.to_string())?;
    let mut out = io::stdout().lock();
    writeln!(out, "{READY_PREFIX}{ready_json}").map_err(|e| e.to_string())?;
    out.flush().map_err(|e| e.to_string())?;
    Ok(())
}

fn random_token() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(32)
        .map(char::from)
        .collect()
}

fn print_help() {
    println!(
        "miterm-agent {AGENT_VERSION} — remote PTY keep-alive broker\n\n\
         Usage:\n\
           miterm-agent [--host 127.0.0.1] [--port 0] [--token SECRET] [--state-dir DIR]\n\
           miterm-agent --state-dir DIR --probe\n\n\
         On start prints:\n\
           {READY_PREFIX}{{\"version\":\"...\",\"host\":\"127.0.0.1\",\"port\":N,\"token\":\"...\",\"pid\":N}}\n\n\
         --state-dir writes ready.json / agent.pid.\n\
         --probe only prints READY if an instance is already alive (exit 2 if not).\n\
         See docs/保活Agent.md"
    );
}
