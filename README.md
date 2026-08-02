# miterm — SSH 远程终端（Tauri MVP）

基于 **Tauri 2 + Rust + React + TypeScript + xterm.js** 的跨平台 SSH 终端客户端。当前阶段为 **MVP**：密码登录、多会话 Tab、远程 Shell。

## 文档

| 文档 | 说明 |
|------|------|
| [docs/环境安装清单.md](docs/环境安装清单.md) | Ubuntu 22.04 开发环境安装步骤 |
| [docs/Windows环境安装清单.md](docs/Windows环境安装清单.md) | Windows 10/11 开发环境安装步骤 |
| [docs/开发文档.md](docs/开发文档.md) | 架构、目录约定、接口、扩展路线 |
| [docs/使用与Windows联调说明.md](docs/使用与Windows联调说明.md) | **使用说明、Linux 编译检查、Windows GUI 联调** |

## 快速开始

**Linux（无桌面，仅编译）：**

```bash
cd ~/projects/miterm
pnpm install && pnpm run build
cd src-tauri && cargo build
```

**Windows / 有桌面的 Linux（GUI 联调）：**

```powershell
cd D:\Codes\miterm
pnpm install
pnpm tauri dev
```

详见 [使用与 Windows 联调说明](docs/使用与Windows联调说明.md)。

## MVP 范围

- 密码 SSH 登录
- 统一 Tab 主页：固定「主机列表」+ 多会话终端（关会话 Tab 即断开）
- **本地终端**：作为主机条目（与 SSH 同级，可分类）；增加主机时选择类型；Git Bash 等可配置路径
- 设置中可自定义快捷键（默认 Ctrl+Tab 轮换会话 Tab；Ctrl+Shift+[ / ] 切并发窗格；Ctrl+1～9；终端内可用）
- 切换到会话 Tab 后自动聚焦终端，可直接输入
- **并发会话**：勾选多台主机一键同屏连接（网格格子）；格内键入可同步到已加入「并发输入」的会话
- SQLite 保存主机（明文密码，本机便利）
- xterm 终端 + 窗口 resize 同步 PTY
- **SFTP**：SSH 会话「文件」侧栏浏览远程目录、单文件上传、单文件/整夹下载

**暂不包含**：私钥、密码加密、目录递归传输、Shadcn。

## 环境要求

- Ubuntu 22.04 LTS（主开发机）或 Windows 10/11（GUI 联调）
- Rust stable、Node 20+、pnpm
- 见 [环境安装清单](docs/环境安装清单.md) / [Windows 环境安装清单](docs/Windows环境安装清单.md)

## 从 miterminal 迁移

包名 / 标识符已改为 `miterm` / `com.miterm.app`。首次启动若新数据目录尚无主机库，会自动从旧目录拷贝 `hosts.db`（Windows：`%APPDATA%\com.miterminal.app\`）。快捷键等 `localStorage` 设置若仍留在旧 WebView 配置中，需在设置里重新确认一次。

## 调试方法

```powershell
cd D:\Codes\miterm
# 每次调试都需要终端加入
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222"
pnpm tauri dev
```
