//! miterm 远端保活 agent：在 127.0.0.1 上握着 PTY，供本机经 SSH 隧道 attach。

mod protocol;
mod server;
mod session;

use std::env;
use std::io::{self, Write};
use std::net::TcpListener;
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
    let mut bind_port: u16 = 0; // 0 = 系统分配
    let mut token: Option<String> = None;

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
            other => return Err(format!("unknown arg: {other}")),
        }
    }

    if bind_host != "127.0.0.1" && bind_host != "::1" && bind_host != "localhost" {
        eprintln!(
            "warning: binding to {bind_host} exposes the agent; prefer 127.0.0.1 + SSH tunnel"
        );
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
    let ready_json = serde_json::to_string(&ready).map_err(|e| e.to_string())?;
    // 单行 stdout，便于 SSH 捕获
    {
        let mut out = io::stdout().lock();
        writeln!(out, "{READY_PREFIX}{ready_json}").map_err(|e| e.to_string())?;
        out.flush().map_err(|e| e.to_string())?;
    }
    eprintln!(
        "miterm-agent {AGENT_VERSION} listening on {}:{} (pid {})",
        ready.host,
        ready.port,
        ready.pid
    );

    let (sessions, events) = SessionManager::new();
    let sessions = Arc::new(sessions);
    let server = Arc::new(AgentServer::new(token, sessions, events));
    server.serve(listener);
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
           miterm-agent [--host 127.0.0.1] [--port 0] [--token SECRET]\n\n\
         On start, prints one stdout line:\n\
           {READY_PREFIX}{{\"version\":\"...\",\"host\":\"127.0.0.1\",\"port\":N,\"token\":\"...\",\"pid\":N}}\n\n\
         Bind only on loopback and reach via SSH local forward.\n\
         Protocol: NDJSON over TCP; first message must be {{\"type\":\"auth\",\"token\":\"...\"}}.\n\
         See docs/保活Agent.md"
    );
}
