# miterm 使用说明与 Windows GUI 联调指南

本文档面向**已克隆/已开发完成**的 miterm MVP 工程，说明如何运行应用、如何验收功能，以及如何在 **Windows** 上进行带图形界面的开发联调。

配套文档：

| 文档 | 用途 |
|------|------|
| [环境安装清单.md](环境安装清单.md) | Linux（Ubuntu 22.04）开发机环境安装 |
| [Windows环境安装清单.md](Windows环境安装清单.md) | Windows 10/11 开发机环境安装 |
| [开发文档.md](开发文档.md) | 架构、目录、接口约定、扩展路线 |

---

## 1. 项目说明

**miterm** 是基于 Tauri 2 的 SSH 远程终端桌面客户端（MVP 阶段）。

| 项 | 内容 |
|----|------|
| 技术栈 | Tauri 2、Rust（ssh2、portable-pty）、React、TypeScript、xterm.js |
| 当前能力 | 密码登录、统一 Tab 主页（主机列表 + SSH/本地多会话）、本地终端作主机条目、xterm、SQLite 保存主机、无边框圆角窗口（透明） |
| 暂不支持 | 私钥、密码加密存储、目录递归传输等（见 [开发文档 §1](开发文档.md#1-项目概述)） |
| 断线重连 | 设置中可开关自动重连；TCP/SSH keepalive；`exit` 手动重连，关 Tab 不重连；重连后尽量 `cd` 恢复原目录（含相对路径如 `~/ai_completion`） |
| 终端字号 | 设置 → 连接 →「终端外观」；默认启用 Ctrl+滚轮缩放终端字体（10～28px）；可关手势或手改字号 |
| 远程文件 | SSH 会话侧栏「远程文件」打开 SFTP；默认跟随终端目录；单文件/整夹上传与下载；完成后行内「已下载」可打开本机位置；路径失效自动清标记；悬停 × 可主动清除 |
| 工作区 | 侧栏「工作区」保存/打开命名组合（主机夹分屏或并发）；可按分类筛选与归属（与主机共用分类）；含布局与 cwd；打开时新开一级 Tab；主机列表「收藏会话」按钮开关侧栏 |
| 保存命令 | 侧栏「命令」：新建/编辑常用命令；可按分类筛选与归属（与主机共用分类）；点击标题填入当前终端（不回车）；「运行」填入并执行；跟随并发输入同步 |
| 田字分割 | 主机夹会话右键 → 田字分割，同机再开 3 连接成四格 |

### 目录结构（核心）

```
miterm/
├── src/                      # React 前端
│   ├── App.tsx               # 统一 Tab 主页
│   ├── components/
│   │   ├── AppTabBar.tsx     # 主机列表 + 会话 Tab + 设置 + 窗口控件
│   │   ├── HostListPage.tsx  # 主机列表（SSH / 本地条目）
│   │   ├── HostEditor.tsx    # 新增/编辑（远程或本地）
│   │   ├── SettingsModal.tsx # 设置（快捷键）
│   │   ├── TerminalView.tsx  # 单会话 xterm
│   │   ├── TerminalWorkspace.tsx # 主机夹：二级悬停条 + 同机再连 + 分屏
│   │   ├── ConcurrentWorkspace.tsx # 并发会话网格格子
│   │   ├── WorkspaceSidebar.tsx # 侧栏：工作区 + 远程文件 + 命令
│   │   ├── SavedCommandsPanel.tsx # 常用命令
│   │   ├── RemoteFilePanel.tsx # SFTP 远程目录 / 上传下载（可嵌入侧栏）
│   │   └── WindowControls.tsx # 最小化/最大化/关闭
│   ├── workspace.ts          # 工作区序列化 / SQLite invoke
│   ├── savedCommands.ts      # 常用命令 invoke
│   ├── settings.ts           # 快捷键 / 重连 / 终端字号等 localStorage 配置
│   ├── cwd.ts                # 工作目录跟踪
│   └── hooks/
│       └── useSshTerminal.ts # 按 sessionId 绑定 IPC / 事件
├── src-tauri/                # Rust 后端
│   ├── src/
│   │   ├── lib.rs            # Tauri 命令注册
│   │   ├── db/mod.rs         # SQLite 主机存储
│   │   ├── ssh/mod.rs        # SSH 会话逻辑
│   │   ├── ssh/sftp_ops.rs   # SFTP 列表与传输
│   │   └── local/mod.rs      # 本地 PTY
│   ├── permissions/ssh.toml
│   ├── permissions/hosts.toml
│   └── capabilities/default.json
└── docs/
```

### 界面：统一 Tab 主页

| Tab | 可否关闭 | 内容 |
|-----|----------|------|
| 主机列表（最左，固定） | 否 | 分类筛选 + 主机表（含本地终端条目）；可勾选多台；「收藏会话」开侧栏 |
| 并发 · N 台 | 是（=断开组内全部） | 同屏网格；浮层「并/单」；Tab 栏全选/取消切换 |
| 主机夹（名称 · 总数 · 当前） | 是（=断开夹内全部） | 同机多连接；悬停二级 Tab / `+`；右键水平/垂直/田字分屏；侧栏 |
| 顶栏「设置」 | — | 快捷键等 |

默认快捷键：`Ctrl+Tab` / `Ctrl+Shift+Tab` **仅在一级会话 Tab 间**循环（不含主机列表）；`Ctrl+Shift+[` / `]` 在并发组窗格或主机夹当前二级 Tab 窗格间切换；`Ctrl+Alt+←/→/↑/↓` 按布局跳转相邻窗格；`Ctrl+Shift+空格` 交替全部加入/退出并发输入；`Ctrl+Shift+E` 开关侧栏（工作区 / 远程文件 / 命令）；`Ctrl+1`～`9` 跳到第 N 个 Tab（1=主机列表）。设置页按连接 / Tab 导航 / 窗格 / 远程文件分组。
终端内（指针在终端上）默认可用 **Ctrl+滚轮** 缩放字体；设置「连接 → 终端外观」可关闭，或直接改字号。
切换到会话 / 二级 / 窗格后会自动聚焦终端，可直接输入（终端内亦可使用上述快捷键）。

### 数据流简述

1. 「增加 / 编辑」→ 弹窗保存到 SQLite；「分类筛选」切换列表。
2. 「增加主机」可选远程 SSH 或本地终端；本地可归入分类（如「本地」）。
3. 点名称连接 → 若该主机夹已存在则只激活；否则新建主机夹 + 首条会话（`ssh_connect` 或 `local_connect`）。
4. 主机夹内悬停 `+` → 同机再开一条连接；关二级只断一条。
5. **分屏**：在已连接终端上右键 →「垂直分割」「水平分割」或「田字分割」→ 同机再开连接并排/叠放/四格；拖分割条改比例；关窗格只断该连接。右键「复制」（有选区）/「粘贴」（写入当前窗格，跟随并发同步）。
6. **工作区**：主机列表点「收藏会话」（或 `Ctrl+Shift+E`）开侧栏 →「工作区」→ 会话页内可「保存当前」命名；之后可「打开」恢复布局与目录（新开 Tab）。
6. 本地条目右侧**设置**可改 Shell / 路径（如 Git Bash）。
7. 关一级夹 / 对端关闭 → 断开对应会话。

---

## 2. 日常使用（连接 SSH / 本地终端）

1. 启动后默认在 **主机列表** Tab。
2. 用上方 **分类筛选** 管理/筛选分类。
3. 点 **增加主机** 保存信息；点 **名称** 登录，右侧出现主机夹 Tab（如 `生产机` + 叠层 `1` + 终端 `1`）。再次点同一名称只切回该夹，不新建连接。
4. **同机多连**：鼠标移到终端顶部 → 二级条出现 → 点 **+** 再开一条；显示变为如叠层 `2` · 终端 `2`（先总数、后当前）。
5. **分屏**：终端内右键 → 垂直/水平/田字分割 → 同机新连接出现在**当前二级 Tab**内（不会多出二级 Tab）；`+` 才新建二级 Tab。拖分割条；右键关窗格 / 二级条 × 关整页。分屏默认同组并发（竖线/方块光标）。`Ctrl+Alt+方向键` 聚焦相邻窗格。
6. **本地终端**：「增加主机」选本地终端 → 选 Shell（Git Bash / 自定义可填路径）→ 保存到列表（建议分类「本地」）→ 点名称打开。
7. 顶栏在「主机列表」与各一级 Tab 之间切换（也可用快捷键）；一级 **×** 断开夹内全部；二级 **×** 只断一条。
8. **并发会话**：勾选至少 2 台主机 → 点「并发会话」同时连接；网格同屏。悬停格子时浮层可点「并/单」；Tab 栏图标在「全选 / 全部取消」间切换。关组 Tab 断开全部。
9. 点顶栏 **设置** 可修改快捷键；本地终端路径在对应条目的设置图标中修改。

> **安全提示**：密码经 Tauri IPC 传给 Rust，并**明文**保存在本机 `hosts.db`；仅建议在受信本机使用。MVP 未校验 `known_hosts`。

---

## 3. Linux 上仅编译（无桌面）

当前若在**无图形界面**的服务器上开发，可只做编译检查，不弹窗：

```bash
export PATH="/usr/bin:/usr/local/bin:$PATH"
source "$HOME/.cargo/env"
cd ~/projects/miterm

pnpm install
pnpm run build              # 前端 TypeScript + Vite 构建

cd src-tauri
cargo build                 # Rust + 链接 libssh2
cargo clippy -- -D warnings # 静态检查（可选）
```

通过即表示代码与依赖链正常；**GUI 联调需在 Windows 或带桌面的 Linux/macOS 上进行**。

---

## 4. Windows 环境准备

在 Windows 10/11 上进行 `pnpm tauri dev` 前，需安装以下工具。

### 4.1 必装软件

| 软件 | 版本建议 | 说明 |
|------|----------|------|
| [Node.js](https://nodejs.org/) | **20 LTS** | 安装时勾选添加到 PATH；`node -v` 应为 v20.x |
| pnpm | 10.x | `corepack enable` 后 `corepack prepare pnpm@10 --activate` |
| [Rust](https://www.rust-lang.org/tools/install) | stable | 安装 rustup 默认 stable 工具链 |
| [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) | 2019+ | 勾选 **「使用 C++ 的桌面开发」**，提供 MSVC 链接器 |
| [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/) |  Evergreen | Win10/11 通常已自带；Tauri 依赖系统 WebView2 |

> **不要用** Cursor/IDE 内置 Node 跑 Tauri。在 PowerShell 中执行 `where.exe node`，应指向 `C:\Program Files\nodejs\node.exe` 等系统路径。

### 4.2 启用 pnpm（PowerShell 管理员，可选）

```powershell
corepack enable
corepack prepare pnpm@10 --activate
pnpm -v
```

### 4.3 拉取代码并安装依赖

```powershell
cd D:\Codes\miterm
pnpm install
```

首次 `pnpm tauri dev` 会编译 Rust 依赖，耗时数分钟属正常。

### 4.4 libssh2 说明（Windows）

Rust `ssh2` crate 在 Windows 上通常通过 `libssh2-sys` 自动编译或拉取预编译依赖，**一般无需**像 Linux 那样 `apt install libssh2-1-dev`。若 `cargo build` 报 OpenSSL/libssh2 相关错误，可安装 [vcpkg](https://vcpkg.io/) 并按 [ssh2 crate 文档](https://docs.rs/ssh2/latest/ssh2/) 配置，或先以默认 rustls/openssl 特性重试构建。

---

## 5. Windows GUI 联调步骤

### 5.1 准备 SSH 测试目标

任选其一即可：

**方案 A：本机 OpenSSH 服务（推荐）**

1. **设置 → 应用 → 可选功能 → 添加功能**，安装 **OpenSSH 服务器**。
2. PowerShell（管理员）启动服务：

```powershell
Start-Service sshd
Set-Service -Name sshd -StartupType Automatic
Get-Service sshd
```

3. 确认监听：

```powershell
netstat -an | findstr ":22"
```

4. 确认允许密码登录（`C:\ProgramData\ssh\sshd_config`）：

```
PasswordAuthentication yes
```

修改后重启：`Restart-Service sshd`

5. 为测试用户设置密码（若用 Microsoft 账户本地登录，需为本地账户设置密码）。

**方案 B：连 Linux 虚拟机 / 远程服务器**

- 表单中 Host 填虚拟机 IP 或域名，Port/User/Password 填对应值。

**方案 C：Docker 测试容器（需 Docker Desktop）**

```powershell
docker run -d --name ssh-test -p 2222:22 `
  -e PASSWORD_ACCESS=true -e USER_PASSWORD=secret `
  linuxserver/openssh-server
```

连接时 Port 填 `2222`，密码 `secret`。

### 5.2 启动开发模式（弹窗）

在项目根目录 PowerShell：

```powershell
cd D:\Codes\miterm
pnpm tauri dev
```

- 首次会编译 `src-tauri`，完成后自动打开 **miterm** 窗口。
- 前端 Vite 热更新；Rust 改动会触发重新编译。
- 若本机曾用旧名 **miterminal**（`com.miterminal.app`）保存过主机：首次启动会把 `%APPDATA%\com.miterminal.app\hosts.db` 拷到 `%APPDATA%\com.miterm.app\`（新目录已有库则跳过）。快捷键等设置若未出现，在「设置」里确认一次即可。

### 5.3 联调验收清单

| # | 操作 | 预期 |
|---|------|------|
| 1 | `pnpm tauri dev` | 窗口正常打开，无白屏/报错 |
| 2 | 连接 `127.0.0.1:22`，本机用户 + 密码 | 终端出现 shell 提示符（如 `PS C:\...` 或 `C:\Users\...>`） |
| 3 | 执行 `dir`、`cd`、`echo hello` | 输出正确 |
| 4 | 拖动放大窗口 | 远程 `stty size`（Linux）或终端布局随窗口变化 |
| 5 | 关主机夹 Tab → 再点名称登录 | 新建夹；无重复乱码、无卡死 |
| 5b | 夹已存在时再点列表名称 | 只激活该夹，不新建连接 / 不增加数量 |
| 5c | 悬停顶部 → `+` 再连 → 关二级 × | 一级标题数量增减正确；最后一条二级关掉后夹消失 |
| 6 | 增加主机 → 本地终端（如 Git Bash + 路径） | 列表出现普通条目（可归类），无固定首行 |
| 7 | 点本地条目名称 / 右侧设置图标 | 打开主机夹可交互；设置可改 Shell 与路径 |
| 8 | 终端内 Ctrl+Tab / Ctrl+1～9 | Ctrl+Tab 只在一级 Tab 间轮换（含并发组与主机夹）；Ctrl+1 回主机列表 |
| 8b | 并发组 / 主机夹内 Ctrl+Shift+[ / ] | 组内格子或夹内二级会话循环；非此类 Tab 时无效果 |
| 8c | 主机夹终端右键 → 垂直/水平/田字分割 | 同机新连接分屏；可拖分割条；关窗格只断该格 |
| 8d | 分屏后键入 / 右键加入退出 / Tab 四格 | 默认同组同步；竖线=已加入，方块=未加入；全选/取消可用 |
| 8d2 | 已连接终端右键 → 粘贴 | 剪贴板内容写入当前窗格；若在并发组则同步到已加入会话 |
| 8e | 主机列表「收藏会话」/ Ctrl+Shift+E；侧栏打开工作区；Ctrl+Alt+方向键 | 无连接也可开侧栏；命名组合可再开；按布局跳转相邻窗格 |
| 8e2 | 工作区选分类后「保存当前」；列表筛选 / 改分类 | 归属正确；删主机分类后工作区变未分类 |
| 8f | 侧栏拉宽使主机表出现横向滚动 | 滚动条为深色（与主题一致）；工作区「保存当前」、命令「新建」不随侧栏无限变宽 |
| 9 | 勾选 ≥2 台 → 并发会话 | 出现「并发 · N 台」Tab；格子相邻铺满；关单格或关组 Tab 行为正确 |
| 10 | 默认全为「并」，在一格输入 | 参与格同步收到；参与=竖线光标、未参与=方块 |
| 11 | Tab 栏并发图标按钮 | 全选↔全部取消同一位置切换图标；浮层顶栏悬停才显示 |
| 12 | 主机夹二级条 | 仅悬停顶部热区显示；平时不挡终端 |
| 13 | 远程 `exit` | 终端提示已退出；出现「重新连接」；不自动重连 |
| 14 | 模拟异常断线（或关服务） | 开启自动重连时打印重连文案并恢复；关 Tab 不会重连 |
| 15 | 设置 → 断线自动重连 | 可关；可改最大次数 |
| 16 | `cd /tmp` 或相对 `cd ai_completion/` 后 `exit` 再重连 | 重连成功后自动 `cd` 回原目录（有「已恢复工作目录」提示）；登录仍有 Last login |
| 16b | `cd ai` + Tab 补全到 `ai_completion/` 后 `exit` 再重连 | 应恢复到完整目录，不能变成 `/home/…/ai` |
| 17 | 点击 Tab × 关闭 | Tab 应几乎立刻消失，不应卡住数秒 |
| 18 | SSH 会话点「文件」 | **左侧**侧栏打开并跟随 cwd；`cd` 后目录更新；敲 `ls` 等**不**闪回 `~/`；「⇄」可关跟随 |
| 19 | 「上传…」→ 文件 / 文件夹 | 列表中出现对应项；文件夹有进度「n/m」 |
| 19b | 拖文件/夹到上传虚线区 → 确定上传 | 确认框列出项后上传成功 |
| 20 | 下载该文件到本机 | 系统保存对话框成功，内容正确；底部进度条随后消失；该行「下载」左侧出现「已下载」，点击应在资源管理器中选中该文件 |
| 20b | 删除本机已下载文件后再点「已下载」 | 提示「本地文件已不存在…」且「已下载」标记消失 |
| 20c | 悬停「已下载」点 × | 标记清除；本机文件仍在 |
| 21 | 目录行点「下载」 | 选本机父目录后生成同名文件夹并递归下载；进度显示「n/m 个文件」；完成后行内「已下载」应打开该本地文件夹 |
| 22 | 侧栏「命令」→ 新建 | 保存标题与命令内容后出现在列表；可选分类 |
| 22b | 点击命令标题 | 填入当前聚焦终端且不回车；可再手改后回车 |
| 22c | 点「运行」 | 填入并回车执行；若该窗格在并发同步中应同步到已加入会话 |
| 22d | 命令筛选 / 改分类 | 与主机分类一致；删分类后命令变未分类 |

**命令行对照**（先确认 SSH 服务本身可用）：

```powershell
ssh 你的用户名@127.0.0.1
```

命令行能登录，则问题多半在应用层（权限、密码字段、事件监听等）。

### 5.4 Release 构建（可选）

```powershell
pnpm tauri build
```

产物位于 `src-tauri\target\release\bundle\`（`.msi` / `.exe` 等，视配置而定）。

---

## 6. 常见问题（Windows）

| 现象 | 处理 |
|------|------|
| `pnpm tauri dev` 报缺少 MSVC | 安装 Visual Studio Build Tools，勾选 C++ 桌面开发 |
| `link.exe` / `LNK` 错误 | 在「x64 Native Tools Command Prompt」或重启终端后再试；确认 `rustup default stable` |
| `node` 指向错误路径 | 调整 PATH，让 `C:\Program Files\nodejs` 优先于 IDE 内置 Node |
| 窗口打开但 invoke 403 | 检查 `src-tauri/permissions/ssh.toml` 与 `capabilities/default.json` 是否包含 `allow-ssh-commands` |
| 连接一直 Connecting | 看 Rust 是否在 `spawn_blocking`；查防火墙是否拦 22 端口 |
| Authentication failed | 确认 OpenSSH 密码登录已开启、账户有密码 |
| 有连接无输出 | 前端是否按 `sessionId` 过滤 `ssh-output`；事件载荷是否为 `{ sessionId, data }` |
| vim/top 布局乱 | 连接成功后应自动 `fit` + `ssh_resize`；手动拖大窗口再试 |

---

## 7. 与 Linux 开发机的协作方式

| 场景 | 建议 |
|------|------|
| 代码在 Linux 服务器上写 | 用 Git 同步到 Windows，或在 Windows 上 `git clone` 同仓库 |
| 只在 Linux 上 `cargo build` | 通过 CI 或本机交叉编译；**Windows GUI 必须在 Windows 本机跑 `tauri dev`** |
| 连同一台 Linux 上的 SSH | Windows 上 miterm 表单的 Host 填 Linux 服务器 IP，不要用 `127.0.0.1`（除非 SSH 装在 Windows 本机） |

---

## 8. 常用命令速查

| 命令 | 说明 |
|------|------|
| `pnpm tauri dev` | 开发模式（热更新 + 桌面窗口） |
| `pnpm tauri build` | Release 打包 |
| `pnpm run build` | 仅构建前端 |
| `cd src-tauri && cargo build` | 仅编译 Rust |
| `cd src-tauri && cargo clippy -- -D warnings` | Rust 静态检查 |

---

## 9. 参考链接

- [Tauri 2 — Windows 前置条件](https://v2.tauri.app/start/prerequisites/)
- [Tauri 2 — 创建/运行项目](https://v2.tauri.app/start/create-project/)
- [OpenSSH for Windows](https://learn.microsoft.com/windows-server/administration/openssh/openssh_install_firstuse)
- [xterm.js](https://xtermjs.org/)
- [rust ssh2 crate](https://docs.rs/ssh2/latest/ssh2/)
