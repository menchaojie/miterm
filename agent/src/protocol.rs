//! 行分隔 JSON（NDJSON）协议。终端字节用 base64 传输。

use serde::{Deserialize, Serialize};

pub const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const READY_PREFIX: &str = "MITERM_AGENT_READY ";

/// 进程启动后写到 stdout 的一行，供 SSH 启动脚本解析。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadyInfo {
    pub version: String,
    pub host: String,
    pub port: u16,
    pub token: String,
    pub pid: u32,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ClientMsg {
    #[serde(rename = "auth")]
    Auth { token: String },
    #[serde(rename = "create")]
    Create {
        #[serde(default)]
        cols: Option<u16>,
        #[serde(default)]
        rows: Option<u16>,
        /// 可选 shell 路径；空则用 $SHELL / 平台默认
        #[serde(default)]
        shell: Option<String>,
        #[serde(default, rename = "sessionId")]
        session_id: Option<String>,
    },
    #[serde(rename = "attach")]
    Attach {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    #[serde(rename = "detach")]
    Detach,
    #[serde(rename = "input")]
    Input {
        /// base64 编码的原始字节
        data: String,
    },
    #[serde(rename = "resize")]
    Resize { cols: u16, rows: u16 },
    #[serde(rename = "list")]
    List,
    #[serde(rename = "kill")]
    Kill {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    #[serde(rename = "ping")]
    Ping,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ServerMsg {
    #[serde(rename = "ok")]
    Ok { message: String },
    #[serde(rename = "error")]
    Error { message: String },
    #[serde(rename = "created")]
    Created {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    #[serde(rename = "attached")]
    Attached {
        #[serde(rename = "sessionId")]
        session_id: String,
        /// 重连补发的最近输出（base64）
        replay: String,
        cols: u16,
        rows: u16,
    },
    #[serde(rename = "output")]
    Output {
        /// base64
        data: String,
    },
    #[serde(rename = "sessions")]
    Sessions { items: Vec<SessionInfo> },
    #[serde(rename = "closed")]
    Closed {
        #[serde(rename = "sessionId")]
        session_id: String,
        reason: String,
    },
    #[serde(rename = "pong")]
    Pong,
    #[serde(rename = "detached")]
    Detached {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub alive: bool,
    pub attached: bool,
    pub cols: u16,
    pub rows: u16,
}

pub fn encode_b64(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data)
}

pub fn decode_b64(data: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .map_err(|e| format!("base64: {e}"))
}
