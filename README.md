# miterm

跨平台 SSH / 本地终端客户端（**v1.0.9**）。  
技术栈：**Tauri 2 + Rust + React + TypeScript + xterm.js**。

密码登录、多会话 Tab、主机夹分屏、多机并发、工作区、SFTP、常用命令；可选远端 **miterm-agent** 保活（断线后 shell 仍在，重连 attach）。

## 架构概览

```
React UI（主机 / Tab / 分屏 / xterm）
    invoke ↓          ↑ event（ssh-output / ssh-closed）
Rust（ssh2 · portable-pty · SQLite）
    ├─ 经典 SSH PTY
    ├─ 保活：ensure agent → direct-tcpip → NDJSON
    └─ SFTP 旁路独立连接（不堵终端）
远端（可选）~/.miterm-agent 握着真正的 PTY
```

| 层 | 职责 |
|----|------|
| `src/` | 界面编排、cwd 跟踪、工作区 JSON |
| `src-tauri/` | 连接读写、SFTP、主机/工作区/命令持久化 |
| `agent/` | Linux 保活进程（独立 crate，当前 **0.1.2**） |

- **会话只活在内存**；SQLite 存主机、工作区蓝图、常用命令。
- 每条连接一个 `sessionId`；主机夹（同机分屏）与并发组（多机网格）互斥归属。
- 输入走 `invoke`，输出走 `ssh-output` 事件。细节见 [开发文档](docs/开发文档.md)、[保活Agent](docs/保活Agent.md)。

## 文档

| 文档 | 说明 |
|------|------|
| [docs/使用与Windows联调说明.md](docs/使用与Windows联调说明.md) | 使用说明、Linux 编译、Windows GUI 联调 |
| [docs/开发文档.md](docs/开发文档.md) | 架构、目录、接口、变更记录 |
| [docs/保活Agent.md](docs/保活Agent.md) | miterm-agent 部署 / 协议 / 构建 |
| [docs/环境安装清单.md](docs/环境安装清单.md) | Ubuntu 22.04 开发环境 |
| [docs/Windows环境安装清单.md](docs/Windows环境安装清单.md) | Windows 10/11 开发环境 |

## 快速开始

**Windows / 有桌面的 Linux：**

```powershell
cd D:\Codes\miterm
pnpm install
pnpm tauri dev
```

**Linux（无桌面，仅编译）：**

```bash
cd ~/projects/miterm
pnpm install && pnpm run build
cd src-tauri && cargo build
```

发布安装包：`pnpm tauri build`（产物在 `src-tauri/target/release/bundle/`）。

## 功能

**连接与会话**

- 密码 SSH；本地终端（PowerShell / cmd / Git Bash / 自定义路径）作为主机条目
- 统一 Tab：固定「主页」+ 多会话；回主页不断开
- 断线可手动/自动重连（可关）；TCP/SSH keepalive
- **会话保活**（默认开）：自动部署 `~/.miterm-agent`，闪断 attach 同一 shell；失败回退经典 PTY

**布局**

- **主机夹**：同机二级 Tab；右键垂直 / 水平 / 田字分屏；拖分割条；分屏可并发输入
- **并发组**：勾选多机同屏网格；格内键入可同步到已加入的会话

**工作区与命令**

- 保存/打开主机夹或并发组合（布局 + 各窗 cwd）；保存当前 / 更新保存 / 恢复目录
- 常用命令 + 独立分类；侧栏或 **Ctrl+Shift+P** 面板填入/运行（跟随并发同步）

**文件与终端**

- SFTP 侧栏：浏览、上传（菜单或拖放确认）、整夹下载；进度条；「已下载」可打开本机位置
- xterm；字号设置与 Ctrl+滚轮缩放；复制/粘贴；Ctrl+点击打开链接
- 快捷键可配（Tab 轮换、窗格跳转、侧栏、命令面板等）

**数据**：SQLite 存主机（明文密码，本机便利）、分类、工作区、命令。

**暂不包含**：私钥 / 证书、跳板机、密码加密、`known_hosts`、Shadcn。

## 环境要求

- Ubuntu 22.04 或 Windows 10/11
- Rust stable、Node 20+、pnpm
- Windows 另需 MSVC Build Tools（见环境清单）

## 从 miterminal 迁移

标识符为 `com.miterm.app`。首次启动若新数据目录无库，会从旧 `%APPDATA%\com.miterminal.app\` 拷贝 `hosts.db`。`localStorage` 设置若未带过来，在「设置」里确认一次即可。

## 调试

```powershell
cd D:\Codes\miterm
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222"
pnpm tauri dev
```

浏览器打开 `http://localhost:9222` 可检视 WebView。
