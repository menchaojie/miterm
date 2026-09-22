//! 远端 miterm-agent：探测 arch、上传、ensure、direct-tcpip、NDJSON 会话。

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;
use std::{fs, thread};

use base64::Engine;
use serde::{Deserialize, Serialize};
use ssh2::Session;
use tauri::{AppHandle, Manager};

/// 与 **已打包** 的 `resources/miterm-agent/*` 对齐（源码 agent 可能更新，需重建 Linux 产物后再抬版本）。
pub const AGENT_VERSION: &str = "0.1.2";
const READY_PREFIX: &str = "MITERM_AGENT_READY ";
const REMOTE_DIR: &str = ".miterm-agent";
const REMOTE_BIN: &str = "miterm-agent";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentReady {
    pub version: String,
    pub host: String,
    pub port: u16,
    pub token: String,
    pub pid: u32,
}

pub fn resolve_local_agent_binary(app: &AppHandle, arch: &str) -> Option<PathBuf> {
    let name = match normalize_arch(arch) {
        Some("x86_64") => "miterm-agent-linux-x86_64",
        Some("aarch64") => "miterm-agent-linux-aarch64",
        _ => return None,
    };

    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("miterm-agent").join(name));
        candidates.push(dir.join("resources").join("miterm-agent").join(name));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("miterm-agent").join(name));
            candidates.push(parent.join("resources").join("miterm-agent").join(name));
        }
    }
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    candidates.push(manifest.join("resources/miterm-agent").join(name));
    candidates.push(manifest.join("../agent/dist").join(name));

    candidates.into_iter().find(|p| p.is_file())
}

fn normalize_arch(arch: &str) -> Option<&'static str> {
    match arch.trim().to_ascii_lowercase().as_str() {
        "x86_64" | "amd64" | "x64" => Some("x86_64"),
        "aarch64" | "arm64" => Some("aarch64"),
        _ => None,
    }
}

pub fn ssh_exec(sess: &Session, cmd: &str) -> Result<(i32, String, String), String> {
    let mut channel = sess
        .channel_session()
        .map_err(|e| format!("exec channel: {e}"))?;
    channel
        .exec(cmd)
        .map_err(|e| format!("exec `{cmd}`: {e}"))?;

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        match channel.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => stdout.extend_from_slice(&buf[..n]),
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                if channel.eof() {
                    break;
                }
                thread::sleep(Duration::from_millis(5));
            }
            Err(e) => return Err(format!("exec read: {e}")),
        }
    }
    loop {
        match channel.stderr().read(&mut buf) {
            Ok(0) => break,
            Ok(n) => stderr.extend_from_slice(&buf[..n]),
            Err(_) => break,
        }
    }
    let _ = channel.wait_close();
    let code = channel.exit_status().unwrap_or(-1);
    Ok((
        code,
        String::from_utf8_lossy(&stdout).into_owned(),
        String::from_utf8_lossy(&stderr).into_owned(),
    ))
}

pub fn detect_remote_arch(sess: &Session) -> Result<String, String> {
    let (code, out, err) = ssh_exec(sess, "uname -m")?;
    if code != 0 {
        return Err(format!("uname -m failed ({code}): {err}"));
    }
    let arch = out.trim().to_string();
    if arch.is_empty() {
        return Err("uname -m empty".into());
    }
    Ok(arch)
}

fn remote_version(sess: &Session) -> Option<String> {
    let cmd = format!("test -x ~/{REMOTE_DIR}/{REMOTE_BIN} && ~/{REMOTE_DIR}/{REMOTE_BIN} --version");
    let (code, out, _) = ssh_exec(sess, &cmd).ok()?;
    if code != 0 {
        return None;
    }
    // "miterm-agent 0.1.1"
    out.split_whitespace().nth(1).map(|s| s.trim().to_string())
}

/// 上传到 `miterm-agent.new`，停旧进程后再 `mv` 替换，避免覆盖正在运行的二进制失败。
/// 注意：停旧 agent 会丢掉其下所有保活 PTY（版本升级预期行为）。
fn upload_agent(sess: &Session, local: &Path) -> Result<(), String> {
    let data = fs::read(local).map_err(|e| format!("read agent binary: {e}"))?;
    let sftp = sess.sftp().map_err(|e| format!("sftp: {e}"))?;

    let home = {
        let (code, out, err) = ssh_exec(sess, "printf %s \"$HOME\"")?;
        if code != 0 || out.trim().is_empty() {
            return Err(format!("resolve HOME failed: {err}"));
        }
        out.trim().to_string()
    };
    let dir = format!("{home}/{REMOTE_DIR}");
    let bin = format!("{dir}/{REMOTE_BIN}");
    let bin_new = format!("{dir}/{REMOTE_BIN}.new");

    match sftp.mkdir(Path::new(&dir), 0o755) {
        Ok(()) => {}
        Err(e) => {
            let msg = e.to_string().to_ascii_lowercase();
            if !msg.contains("exists") {
                if sftp.stat(Path::new(&dir)).is_err() {
                    return Err(format!("mkdir {dir}: {e}"));
                }
            }
        }
    }

    // 先写临时文件（不碰正在执行的 inode）
    let _ = sftp.unlink(Path::new(&bin_new));
    let mut remote = sftp
        .create(Path::new(&bin_new))
        .map_err(|e| format!("sftp create {bin_new}: {e}"))?;
    remote
        .write_all(&data)
        .map_err(|e| format!("sftp write: {e}"))?;
    drop(remote);

    let replace_cmd = format!(
        r#"
set -e
DIR="{dir}"
BIN="{bin}"
NEW="{bin_new}"
chmod 755 "$NEW"
# 停旧实例：只用 pid 文件 / 进程名，禁止 pkill -f "$BIN"（会误杀本脚本）
if [ -f "$DIR/agent.pid" ]; then
  kill "$(cat "$DIR/agent.pid")" 2>/dev/null || true
fi
if [ -f "$DIR/ready.json" ]; then
  pid=$(sed -n 's/.*"pid":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$DIR/ready.json" | head -n1)
  if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi
fi
pkill -x miterm-agent 2>/dev/null || true
sleep 0.3
mv -f "$NEW" "$BIN"
chmod 755 "$BIN"
rm -f "$DIR/ready.json"
"#
    );
    let (code, out, err) = ssh_exec(sess, &replace_cmd)?;
    if code != 0 {
        return Err(format!(
            "replace agent binary failed ({code}): {}\n{}",
            err.trim(),
            out.trim()
        ));
    }
    Ok(())
}

fn parse_ready_line(text: &str) -> Result<AgentReady, String> {
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix(READY_PREFIX) {
            return serde_json::from_str(rest.trim())
                .map_err(|e| format!("parse READY: {e}"));
        }
        // ready.json 纯 JSON
        if line.starts_with('{') && line.contains("\"token\"") {
            if let Ok(r) = serde_json::from_str::<AgentReady>(line) {
                return Ok(r);
            }
        }
    }
    Err(format!(
        "no READY in output: {}",
        text.chars().take(200).collect::<String>()
    ))
}

/// 确保远端 agent 已部署并运行，返回 READY。
pub fn ensure_remote_agent(app: &AppHandle, sess: &Session) -> Result<AgentReady, String> {
    sess.set_timeout(60_000);

    let arch = detect_remote_arch(sess)?;
    let local = resolve_local_agent_binary(app, &arch).ok_or_else(|| {
        format!(
            "本机没有对应架构的 agent 二进制（arch={arch}）。请先在 Linux 上构建并放到 agent/dist 或 resources/miterm-agent/"
        )
    })?;

    let need_upload = match remote_version(sess) {
        Some(v) if v == AGENT_VERSION => false,
        Some(v) => {
            eprintln!("[agent] remote version {v} != {AGENT_VERSION}, uploading");
            true
        }
        None => true,
    };
    if need_upload {
        eprintln!(
            "[agent] uploading {} -> ~/{} (safe replace)",
            local.display(),
            REMOTE_DIR
        );
        upload_agent(sess, &local)?;
    }

    // FORCE_RESTART=1：刚升级过，禁止复用旧进程
    // 否则可 probe；若 probe 失败且仍有残留进程，先停再建，避免双实例
    let force = if need_upload { "1" } else { "0" };
    let ensure_cmd = format!(
        r#"
set -e
DIR="$HOME/{REMOTE_DIR}"
BIN="$DIR/{REMOTE_BIN}"
FORCE_RESTART={force}
mkdir -p "$DIR"
if [ ! -x "$BIN" ]; then
  echo "agent binary missing" >&2
  exit 1
fi

stop_agent() {{
  if [ -f "$DIR/agent.pid" ]; then
    kill "$(cat "$DIR/agent.pid")" 2>/dev/null || true
  fi
  if [ -f "$DIR/ready.json" ]; then
    pid=$(sed -n 's/.*"pid":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$DIR/ready.json" | head -n1)
    if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi
  fi
  # -x 按进程名，避免 pkill -f "$BIN" 误杀当前 ensure 脚本
  pkill -x miterm-agent 2>/dev/null || true
  rm -f "$DIR/ready.json"
  sleep 0.2
}}

if [ "$FORCE_RESTART" != "1" ]; then
  if OUT=$("$BIN" --state-dir "$DIR" --probe 2>/dev/null); then
    echo "$OUT" | head -n 1
    exit 0
  fi
  if [ -f "$DIR/ready.json" ]; then
    pid=$(sed -n 's/.*"pid":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$DIR/ready.json" | head -n1)
    if [ -n "$pid" ] && [ -d "/proc/$pid" ]; then
      echo "{READY_PREFIX}$(cat "$DIR/ready.json")"
      exit 0
    fi
  fi
  if [ -f "$DIR/agent.pid" ]; then
    opid=$(cat "$DIR/agent.pid" 2>/dev/null || true)
    if [ -n "$opid" ] && [ -d "/proc/$opid" ]; then
      if line=$(grep -m1 '^{READY_PREFIX}' "$DIR/agent.log" 2>/dev/null); then
        echo "$line"
        exit 0
      fi
    fi
  fi
fi

# 拉起前一律停干净，禁止双开
stop_agent
: > "$DIR/agent.log"
nohup "$BIN" --state-dir "$DIR" >"$DIR/agent.log" 2>&1 </dev/null &
echo $! >"$DIR/agent.pid"
sleep 0.25
if ! grep -q '^{READY_PREFIX}' "$DIR/agent.log" 2>/dev/null && [ ! -f "$DIR/ready.json" ]; then
  if [ -f "$DIR/agent.pid" ]; then kill "$(cat "$DIR/agent.pid")" 2>/dev/null || true; fi
  : > "$DIR/agent.log"
  nohup "$BIN" >"$DIR/agent.log" 2>&1 </dev/null &
  echo $! >"$DIR/agent.pid"
fi
for i in $(seq 1 50); do
  if [ -f "$DIR/ready.json" ]; then
    echo "{READY_PREFIX}$(cat "$DIR/ready.json")"
    exit 0
  fi
  if line=$(grep -m1 '^{READY_PREFIX}' "$DIR/agent.log" 2>/dev/null); then
    echo "$line"
    echo "$line" | sed 's/^{READY_PREFIX}//' > "$DIR/ready.json" || true
    exit 0
  fi
  sleep 0.1
done
echo "agent start timeout" >&2
tail -n 20 "$DIR/agent.log" >&2 || true
exit 1
"#
    );

    let (code, out, err) = ssh_exec(sess, &ensure_cmd)?;
    if code != 0 {
        return Err(format!(
            "ensure agent failed ({code}): {}\n{}",
            err.trim(),
            out.trim()
        ));
    }
    parse_ready_line(&out)
}

pub fn open_agent_tunnel(sess: &Session, ready: &AgentReady) -> Result<ssh2::Channel, String> {
    sess.channel_direct_tcpip(&ready.host, ready.port, None)
        .map_err(|e| format!("direct-tcpip to agent {}:{}: {e}", ready.host, ready.port))
}

fn encode_b64(data: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(data)
}

fn decode_b64(data: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .map_err(|e| format!("base64: {e}"))
}

fn write_line(channel: &mut ssh2::Channel, value: &serde_json::Value) -> Result<(), String> {
    let mut line = serde_json::to_string(value).map_err(|e| e.to_string())?;
    line.push('\n');
    channel
        .write_all(line.as_bytes())
        .map_err(|e| format!("agent write: {e}"))?;
    channel.flush().map_err(|e| format!("agent flush: {e}"))?;
    Ok(())
}

fn read_json_line(
    channel: &mut ssh2::Channel,
    buf: &mut Vec<u8>,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let deadline = std::time::Instant::now() + timeout;
    let mut tmp = [0u8; 4096];
    loop {
        if let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line = buf.drain(..=pos).collect::<Vec<u8>>();
            let text = String::from_utf8_lossy(&line);
            let text = text.trim();
            if text.is_empty() {
                continue;
            }
            return serde_json::from_str(text).map_err(|e| format!("agent json: {e} / {text}"));
        }
        if std::time::Instant::now() >= deadline {
            return Err("agent read timeout".into());
        }
        match channel.read(&mut tmp) {
            Ok(0) => {
                if channel.eof() {
                    return Err("agent channel eof".into());
                }
                thread::sleep(Duration::from_millis(5));
            }
            Ok(n) => buf.extend_from_slice(&tmp[..n]),
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                thread::sleep(Duration::from_millis(5));
            }
            Err(e) => return Err(format!("agent read: {e}")),
        }
    }
}

pub struct AgentHandshake {
    pub agent_session_id: String,
    pub replay: Vec<u8>,
    /// 握手后尚未消费的粘包缓冲
    pub pending: Vec<u8>,
}

pub fn agent_handshake(
    channel: &mut ssh2::Channel,
    ready: &AgentReady,
    cols: u32,
    rows: u32,
    prefer_id: Option<&str>,
) -> Result<AgentHandshake, String> {
    let mut buf = Vec::new();

    write_line(
        channel,
        &serde_json::json!({ "type": "auth", "token": ready.token }),
    )?;
    let auth = read_json_line(channel, &mut buf, Duration::from_secs(15))?;
    if auth.get("type").and_then(|v| v.as_str()) != Some("ok") {
        return Err(format!("agent auth failed: {auth}"));
    }

    let (agent_session_id, attached) = if let Some(id) =
        prefer_id.map(str::trim).filter(|s| !s.is_empty())
    {
        write_line(
            channel,
            &serde_json::json!({ "type": "attach", "sessionId": id }),
        )?;
        let att = read_json_line(channel, &mut buf, Duration::from_secs(15))?;
        if att.get("type").and_then(|v| v.as_str()) == Some("attached") {
            (id.to_string(), att)
        } else {
            write_line(
                channel,
                &serde_json::json!({
                    "type": "create",
                    "cols": cols,
                    "rows": rows,
                    "sessionId": id,
                }),
            )?;
            let created = read_json_line(channel, &mut buf, Duration::from_secs(15))?;
            if created.get("type").and_then(|v| v.as_str()) != Some("created") {
                // id 可能仍被占用且已死：换新 id
                write_line(
                    channel,
                    &serde_json::json!({ "type": "create", "cols": cols, "rows": rows }),
                )?;
                let created2 = read_json_line(channel, &mut buf, Duration::from_secs(15))?;
                let new_id = created2
                    .get("sessionId")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| format!("create failed: {created2}"))?
                    .to_string();
                write_line(
                    channel,
                    &serde_json::json!({ "type": "attach", "sessionId": new_id }),
                )?;
                let att2 = read_json_line(channel, &mut buf, Duration::from_secs(15))?;
                if att2.get("type").and_then(|v| v.as_str()) != Some("attached") {
                    return Err(format!("attach failed: {att2}"));
                }
                (new_id, att2)
            } else {
                let new_id = created
                    .get("sessionId")
                    .and_then(|v| v.as_str())
                    .unwrap_or(id)
                    .to_string();
                write_line(
                    channel,
                    &serde_json::json!({ "type": "attach", "sessionId": new_id }),
                )?;
                let att2 = read_json_line(channel, &mut buf, Duration::from_secs(15))?;
                if att2.get("type").and_then(|v| v.as_str()) != Some("attached") {
                    return Err(format!("attach failed: {att2}"));
                }
                (new_id, att2)
            }
        }
    } else {
        write_line(
            channel,
            &serde_json::json!({ "type": "create", "cols": cols, "rows": rows }),
        )?;
        let created = read_json_line(channel, &mut buf, Duration::from_secs(15))?;
        let new_id = created
            .get("sessionId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("create failed: {created}"))?
            .to_string();
        write_line(
            channel,
            &serde_json::json!({ "type": "attach", "sessionId": new_id }),
        )?;
        let att = read_json_line(channel, &mut buf, Duration::from_secs(15))?;
        if att.get("type").and_then(|v| v.as_str()) != Some("attached") {
            return Err(format!("attach failed: {att}"));
        }
        (new_id, att)
    };

    let replay = attached
        .get("replay")
        .and_then(|v| v.as_str())
        .map(decode_b64)
        .transpose()?
        .unwrap_or_default();

    Ok(AgentHandshake {
        agent_session_id,
        replay,
        pending: buf,
    })
}

pub fn agent_send_input(channel: &mut ssh2::Channel, data: &[u8]) -> Result<(), String> {
    write_line(
        channel,
        &serde_json::json!({
            "type": "input",
            "data": encode_b64(data),
        }),
    )
}

pub fn agent_send_resize(channel: &mut ssh2::Channel, cols: u32, rows: u32) -> Result<(), String> {
    write_line(
        channel,
        &serde_json::json!({
            "type": "resize",
            "cols": cols,
            "rows": rows,
        }),
    )
}

pub fn agent_send_detach(channel: &mut ssh2::Channel) {
    let _ = write_line(channel, &serde_json::json!({ "type": "detach" }));
}

pub fn agent_send_kill(channel: &mut ssh2::Channel, agent_session_id: &str) {
    let _ = write_line(
        channel,
        &serde_json::json!({
            "type": "kill",
            "sessionId": agent_session_id,
        }),
    );
}

/// 从缓冲/通道读出下一条完整 JSON；无完整行时返回 Ok(None)（软）。
pub fn agent_try_read_message(
    channel: &mut ssh2::Channel,
    buf: &mut Vec<u8>,
) -> Result<Option<serde_json::Value>, String> {
    let mut tmp = [0u8; 8192];
    match channel.read(&mut tmp) {
        Ok(0) => {
            if channel.eof() {
                return Err("agent eof".into());
            }
        }
        Ok(n) => buf.extend_from_slice(&tmp[..n]),
        Err(e)
            if e.kind() == std::io::ErrorKind::WouldBlock
                || e.kind() == std::io::ErrorKind::TimedOut => {}
        Err(e) => {
            let msg = e.to_string().to_ascii_lowercase();
            if msg.contains("connection reset")
                || msg.contains("broken pipe")
                || msg.contains("connection aborted")
            {
                return Err(format!("agent fatal: {e}"));
            }
            // 其它错误交给上层决定
            return Err(format!("agent read: {e}"));
        }
    }

    if let Some(pos) = buf.iter().position(|&b| b == b'\n') {
        let line = buf.drain(..=pos).collect::<Vec<u8>>();
        let text = String::from_utf8_lossy(&line);
        let text = text.trim();
        if text.is_empty() {
            return Ok(None);
        }
        let v: serde_json::Value =
            serde_json::from_str(text).map_err(|e| format!("agent json: {e}"))?;
        return Ok(Some(v));
    }
    Ok(None)
}

pub fn message_output_bytes(msg: &serde_json::Value) -> Option<Vec<u8>> {
    if msg.get("type").and_then(|v| v.as_str()) != Some("output") {
        return None;
    }
    let data = msg.get("data").and_then(|v| v.as_str())?;
    decode_b64(data).ok()
}

pub fn message_is_session_closed(msg: &serde_json::Value, agent_session_id: &str) -> bool {
    msg.get("type").and_then(|v| v.as_str()) == Some("closed")
        && msg.get("sessionId").and_then(|v| v.as_str()) == Some(agent_session_id)
}
