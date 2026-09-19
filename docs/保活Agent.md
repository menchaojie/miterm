# miterm 保活 Agent（miterm-agent）

远端会话保活组件：**在服务器用户目录握着真正的 PTY/shell**，本机 SSH 断线后会话仍在；再连只是重新 attach，不是新开一个壳。

> 状态：**已接入 miterm 客户端**（设置「会话保活」默认开启）。  
> 连接 SSH 时自动部署/拉起 agent，经 SSH `direct-tcpip` 隧道使用；失败则回退经典 SSH PTY。

配套：[开发文档.md](开发文档.md)、[使用与Windows联调说明.md](使用与Windows联调说明.md)

---

## 1. 它是什么 / 不是什么

| | 说明 |
|--|------|
| **是** | 装在远端 `~/.miterm-agent/`、用你自己 SSH 账号跑的小程序；只听 `127.0.0.1` |
| **不是** | 系统级服务、`apt` 安装、也不等同于 Xterminal 的监控脚本 |
| **和 tmux** | 同类能力（会话存活），但是自研协议与 UX，不依赖服务器装 tmux |

**权限来源**：你本来就能写家目录、跑二进制；客户端自动化「上传 + 启动 + 隧道」。

**PTY**：伪终端。保活的关键是 agent 握着 PTY；SSH 只当遥控器。

---

## 2. 架构（客户端自动路径）

```
miterm (Windows)
  ssh_connect(persistSession=true)
        │  密码 SSH
        ├─ uname -m / 版本检查
        ├─ SFTP 上传 resources 内 Linux 二进制（如需要）
        ├─ ensure：probe 或 nohup 拉起
        ├─ channel_direct_tcpip → 127.0.0.1:agentPort
        └─ NDJSON：auth / create|attach / input / output
              │
远端 ~/.miterm-agent/miterm-agent
        ├─ session UUID → PTY → shell
        └─ 客户端断线：detach，PTY 仍在
```

- **关 Tab**：向 agent 发 `kill`，结束该 PTY。  
- **网络闪断**：不发 kill；重连时带上 `agentSessionId` 再 `attach`，回放 ring（约 256KB）。  
- **失败回退**：无对应 arch 二进制、上传失败、ensure 失败 → 经典 `request_pty` + shell。

---

## 3. 用户怎么用

1. 设置 → 连接 → **会话保活（远端 agent）**（默认开）。  
2. 正常连 SSH。首次可能稍慢（上传约 1MB）。  
3. 成功时终端系统提示：「已启用会话保活（远端 agent）」。  
4. **测保活**：终端右上角 **「模拟断线（测保活）」** → 再点「重新连接」。不要 `exit`、不要关 Tab。成功时不应出现「已恢复工作目录」。  
5. 关闭保活：取消勾选后新连接走经典 PTY。

远端目录：`~/.miterm-agent/`（`miterm-agent`、`agent.log`、`ready.json`、`agent.pid`）。

卸载：服务器上结束进程并删除该目录即可。

---

## 4. 仓库位置

```
miterm/
├── agent/                      # 独立 crate
│   └── src/…
├── src-tauri/
│   ├── resources/miterm-agent/ # 打进安装包的 Linux 二进制
│   │   └── miterm-agent-linux-x86_64
│   └── src/ssh/agent_bridge.rs # 部署 / 隧道 / 协议
├── scripts/build-agent.sh|.ps1
└── docs/保活Agent.md
```

客户端校验版本常量：`src-tauri/src/ssh/agent_bridge.rs` → `AGENT_VERSION`（须与 **已打包二进制** 一致）。

---

## 5. 构建 Linux 产物

在 Linux / CI 上：

```bash
./scripts/build-agent.sh musl           # → agent/dist/miterm-agent-linux-x86_64
./scripts/build-agent.sh musl aarch64   # ARM
```

同步进客户端资源（本机构建 Tauri 时 `build.rs` 也会尝试从 `agent/dist` 拷贝）：

```powershell
Copy-Item -Force agent\dist\miterm-agent-linux-x86_64 src-tauri\resources\miterm-agent\
# 若源码版本升高，同步改 agent_bridge.rs 的 AGENT_VERSION
```

Windows 本机只能编 Windows 版做协议冒烟：`scripts/build-agent.ps1` + `scripts/agent-smoke.ps1`。

---

## 6. 协议摘要

NDJSON over TCP（经 SSH direct-tcpip）。

| 方向 | type | 说明 |
|------|------|------|
| → | `auth` | token |
| → | `create` / `attach` / `detach` / `kill` | 会话 |
| → | `input` / `resize` | data 为 base64 |
| ← | `output` / `attached`(含 replay) / `closed` | |

启动 stdout：`MITERM_AGENT_READY {...}`  
可选：`--state-dir DIR` 写 `ready.json`；`--probe` 仅探测已有实例。

---

## 7. 验收清单

- [x] agent crate + Windows 冒烟  
- [x] 远端手动 READY / reattach  
- [x] 客户端自动部署 + direct-tcpip + I/O  
- [x] 设置开关 + 失败回退经典 PTY  
- [x] 重连携带 `agentSessionId`  
- [ ] 打包进安装包后在干净机器上验证 resources  
- [ ] aarch64 二进制（当前仅 x86_64 资源）

---

## 8. 限制

- 无 x86_64 资源文件时，保活会失败并回退经典模式。  
- agent 进程被杀则所有保活会话丢失。  
- 重连回放可能与终端已有缓冲视觉重叠（可接受；后续可在 agent 重连时清屏）。  
- 勿把 agent 绑到公网地址。
