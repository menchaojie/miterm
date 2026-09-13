# miterm 保活 Agent（miterm-agent）

远端会话保活组件：**在服务器用户目录握着真正的 PTY/shell**，本机 SSH 断线后会话仍在；再连只是重新 attach，不是新开一个壳。

> 状态：**MVP 已落地**（独立进程 + 协议 + 本机冒烟）。  
> **尚未**接入 miterm 客户端自动部署/隧道；当前用手动启动 + SSH 本地转发验证。

配套：[开发文档.md](开发文档.md)、[使用与Windows联调说明.md](使用与Windows联调说明.md)

---

## 1. 它是什么 / 不是什么

| | 说明 |
|--|------|
| **是** | 装在远端 `~/` 下、用你自己 SSH 账号跑的小程序；听 `127.0.0.1`，经 SSH 隧道由本机连接 |
| **不是** | 系统级服务、`apt` 安装、也不等同于 Xterminal 的监控脚本（`~/.xterminal`） |
| **和 tmux** | 同类能力（会话存活），但是自研协议与 UX，不依赖服务器装 tmux |

**权限来源**：你本来就能在服务器写家目录、跑二进制；客户端只是自动化「上传 + 启动 + 转发」。严管环境若禁止可执行文件/常驻进程，则无法使用。

**PTY（伪终端）**：给 shell 一块「假屏幕+键盘」，这样 vim、颜色、Ctrl+C 才正常。保活的关键是 **agent 握着 PTY**，SSH 只当遥控器；遥控器断了，PTY 还在。

---

## 2. 架构

```
本机 miterm / 测试客户端
        │  SSH（含 LocalForward）
        ▼
远端 ~/.miterm-agent/miterm-agent
        │  127.0.0.1:随机端口 + token
        ├─ session A  →  PTY → bash
        └─ session B  →  PTY → bash
```

- 客户端 **断开 TCP**：agent **只 detach**，不杀 PTY。
- 再 **attach** 同一 `sessionId`：先回放环形缓冲（约 256KB 最近输出），再续实时输出。
- 同一 session **同时只允许一个 attach**。

---

## 3. 仓库位置

```
miterm/
├── agent/                 # 独立 crate（非 Tauri 插件）
│   ├── Cargo.toml
│   └── src/
│       ├── main.rs        # 启动、READY 行、参数
│       ├── protocol.rs    # NDJSON 协议
│       ├── session.rs     # PTY / ring buffer
│       └── server.rs      # TCP 服务
├── scripts/
│   ├── agent-smoke.ps1    # Windows 本机冒烟（已验证保活）
│   ├── build-agent.sh     # Linux / musl 构建
│   └── build-agent.ps1    # Windows 本机构建（调试用）
└── docs/保活Agent.md      # 本文档
```

版本号：`agent/Cargo.toml` → `0.1.0`（启动 READY 与 `--version` 同源）。

---

## 4. 构建

### 4.1 Windows 本机（协议/冒烟）

本机可编出 **Windows** 版 agent（ConPTY），用于验证协议与「断线再 attach」：

```powershell
cd D:\Codes\miterm\agent
cargo build --release
# 或
powershell -File ..\scripts\build-agent.ps1
powershell -File ..\scripts\agent-smoke.ps1
```

冒烟成功时会打印：`OK: reattach replay 含 marker — 保活生效`。

### 4.2 Linux 服务器目标产物（正式部署）

agent **正式跑在 Linux**。推荐在 **Linux 机 / CI / 已装好的 WSL** 上构建（Windows 直交叉编 musl 因 `portable-pty`/C 依赖通常很麻烦）：

```bash
# 在 Linux 上
cd /path/to/miterm
chmod +x scripts/build-agent.sh
./scripts/build-agent.sh                # 默认当前 glibc target
./scripts/build-agent.sh musl           # 静态 musl（需 musl-tools）
./scripts/build-agent.sh musl aarch64   # ARM64 musl
```

产物建议拷到：

```
agent/dist/miterm-agent-linux-x86_64
agent/dist/miterm-agent-linux-aarch64
```

**依赖**：Rust stable；musl 时：`sudo apt install musl-tools`，并 `rustup target add x86_64-unknown-linux-musl`（或 aarch64）。

---

## 5. 手动部署与验证（Linux）

### 5.1 上传并启动

```bash
ssh user@host 'mkdir -p ~/.miterm-agent'
scp agent/dist/miterm-agent-linux-x86_64 user@host:~/.miterm-agent/miterm-agent
ssh user@host 'chmod +x ~/.miterm-agent/miterm-agent'

# 前台看 READY（或 nohup 后读日志）
ssh user@host '~/.miterm-agent/miterm-agent'
# stdout 一行：
# MITERM_AGENT_READY {"version":"0.1.0","host":"127.0.0.1","port":12345,"token":"...","pid":...}
```

### 5.2 SSH 本地转发

另开终端（把 `PORT` / `TOKEN` 换成 READY 里的值）：

```bash
ssh -L 17989:127.0.0.1:PORT user@host -N
```

本机连 `127.0.0.1:17989` 即等于连远端 agent。

### 5.3 最小协议对话（示例）

行分隔 JSON；`input` / `output` / `replay` 的 `data` 为 **标准 base64**。

```text
→ {"type":"auth","token":"<TOKEN>"}
← {"type":"ok","message":"authenticated"}
→ {"type":"create","cols":80,"rows":24}
← {"type":"created","sessionId":"<UUID>"}
→ {"type":"attach","sessionId":"<UUID>"}
← {"type":"attached","sessionId":"...","replay":"...","cols":80,"rows":24}
→ {"type":"input","data":"<base64 of bytes>"}
← {"type":"output","data":"..."}
→ {"type":"detach"}
← {"type":"detached","sessionId":"..."}
# 断开 TCP 后再连、auth、attach 同一 sessionId → replay 应含断开前输出
```

其它消息：`resize` / `list` / `kill` / `ping`→`pong`。详见下文协议表。

CLI：

```
miterm-agent [--host 127.0.0.1] [--port 0] [--token SECRET]
miterm-agent --version
```

安全默认：只绑回环；每次启动随机 token（可用 `--token` 固定，仅调试）。

---

## 6. 协议摘要

传输：**TCP + NDJSON**（每行一个 JSON，UTF-8）。

### 客户端 → agent

| type | 字段 | 说明 |
|------|------|------|
| `auth` | `token` | 必须第一条 |
| `create` | `cols?` `rows?` `shell?` `sessionId?` | 开 PTY；可指定 id |
| `attach` | `sessionId` | 独占绑定；回放 ring |
| `detach` | | 解绑，PTY 继续 |
| `input` | `data` (base64) | 键盘/粘贴 |
| `resize` | `cols` `rows` | |
| `list` | | 会话列表 |
| `kill` | `sessionId` | 杀 PTY |
| `ping` | | |

### agent → 客户端

| type | 说明 |
|------|------|
| `ok` / `error` | |
| `created` | `sessionId` |
| `attached` | `sessionId` `replay` `cols` `rows` |
| `output` | `data` base64 |
| `detached` / `closed` | |
| `sessions` | `items[]` |
| `pong` | |

启动 stdout（非协议连接）：

```
MITERM_AGENT_READY {"version","host","port","token","pid"}
```

前缀常量：`MITERM_AGENT_READY `（注意末尾空格）。

---

## 7. 与 miterm 客户端集成（下一步，未做）

计划接入时建议：

1. 连接 SSH 后检查 `~/.miterm-agent/version`，不匹配则 SFTP 上传对应 arch 二进制。
2. 若未运行则 exec 启动，解析 `MITERM_AGENT_READY`。
3. 用现有 SSH 库做 **LocalForward** 到 `127.0.0.1:port`，带 token 建 NDJSON 会话。
4. 终端 UI 的输入输出走 agent session，而不是裸 SSH shell channel（SFTP 仍可旁路）。
5. 设置项：启用保活 / 首次部署确认 / 卸载（删目录 + kill）。

当前断线体验仍主要依赖「设置里的自动重连」等客户端逻辑；**真正不中断**要等本节打通。

---

## 8. 限制与风险

- agent 进程被杀 → 其下所有 PTY 丢失（与 tmux server 被杀同类）。
- 第一版无超时回收、无多 attach、无加密（依赖 SSH 隧道 + token）。
- 勿把 agent 绑到 `0.0.0.0` 对公网暴露。
- Windows 构建产物 **不能** 当 Linux 服务器 agent 用；服务器请用 §4.2。

---

## 9. 验收清单

- [x] `agent/` 独立 crate，Windows release 可编
- [x] READY 行含 version / port / token
- [x] auth → create → attach → input → 断线 → 再 attach，replay 含先前输入（`scripts/agent-smoke.ps1`）
- [x] 文档本页
- [ ] Linux musl 产物在真实 VPS 上手动转发验收
- [ ] miterm GUI 自动部署与隧道
