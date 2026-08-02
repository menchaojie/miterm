# 环境安装清单（Windows 10 / 11）

在 **Windows 10 / 11** 上手动安装 miterm（Tauri 2 SSH 终端 MVP）开发环境。建议按顺序执行，每步完成后做「验证」再打勾。

> **说明**：本项目前端为 React + TypeScript，后端为 Rust；**无需编写 C++**。安装 Visual Studio Build Tools 时勾选「使用 C++ 的桌面开发」，是为了获得 **MSVC 链接器与 Windows SDK**（Rust 在 Windows 上编译原生依赖与 `.exe` 所需）。详见 [§0 为何需要 MSVC](#0-visual-studio-build-toolsmsvc)。

配套文档：

| 文档 | 用途 |
|------|------|
| [环境安装清单.md](环境安装清单.md) | Linux（Ubuntu 22.04）开发机环境安装 |
| [使用与Windows联调说明.md](使用与Windows联调说明.md) | 运行应用、功能验收、GUI 联调步骤 |
| [开发文档.md](开发文档.md) | 架构、目录约定、接口、扩展路线 |

---

## 安装进度核对表

复制到本地记事本，装完一项勾一项：

```
[ ] 0. Visual Studio Build Tools（MSVC）
[ ] 1. Rust（rustup stable）
[ ] 2. Node.js 20 + pnpm
[ ] 3. WebView2 Runtime（通常已自带）
[ ] 4. 环境自检
[ ] 5. OpenSSH 测试服务（本机联调）
[ ] 6. 项目依赖安装与首次启动
```

---

## 0. Visual Studio Build Tools（MSVC）

### 为何需要 MSVC

| 组件 | 作用 |
|------|------|
| `link.exe` | Rust 默认 `x86_64-pc-windows-msvc` 工具链链接 `.exe` |
| Windows SDK | 链接 Win32 API（Tauri 桌面窗口） |
| `cl.exe` | 编译 `ssh2` → `libssh2-sys` 等 crate 拉取的 **C 语言依赖**（libssh2、OpenSSL、zlib） |

项目本身只有 Rust + TypeScript，**没有 `.cpp` 源码**；装的是 Windows 原生编译工具链，不是让你写 C++。

### 安装步骤

1. 下载 [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
2. 运行安装器，勾选 **「使用 C++ 的桌面开发」**（Desktop development with C++）
3. 右侧确保包含：
   - **MSVC** v143 或更新（x64/x86 生成工具）
   - **Windows 10/11 SDK**
   - C++ CMake tools for Windows（可选，推荐）

安装完成后 **重启终端**（或重启电脑）。

### 验证

PowerShell：

```powershell
where.exe link
# 应输出类似：
# C:\Program Files\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\...\bin\Hostx64\x64\link.exe
```

若找不到，可在开始菜单打开 **「x64 Native Tools Command Prompt for VS 2022」** 再执行上述命令；或确认 Build Tools 已完整安装。

---

## 1. Rust 工具链

### 方式 A：rustup 安装器（推荐）

1. 打开 https://www.rust-lang.org/tools/install
2. 下载并运行 `rustup-init.exe`
3. 提示时选 **1) default install**

或在 PowerShell（已下载 `rustup-init.exe` 的目录）：

```powershell
.\rustup-init.exe -y
rustup default stable
rustup component add rustfmt clippy
```

新开终端后应自动加载 `%USERPROFILE%\.cargo\bin`。若 `cargo` 找不到，手动将上述路径加入系统 **PATH**，然后重开终端。

### 验证

```powershell
rustc --version
cargo --version
```

期望：`rustc 1.75+`（越新越好）。

### 可选：rustup 国内镜像

若下载极慢，可在运行 `rustup-init.exe` **之前**于 PowerShell 设置（[清华源说明](https://mirrors.tuna.tsinghua.edu.cn/help/rustup/)）：

```powershell
$env:RUSTUP_DIST_SERVER = "https://mirrors.tuna.tsinghua.edu.cn/rustup"
$env:RUSTUP_UPDATE_ROOT = "https://mirrors.tuna.tsinghua.edu.cn/rustup/rustup"
.\rustup-init.exe -y
```

---

## 2. Node.js 20 与 pnpm

**不要**只用 Cursor/IDE 内置 Node 跑 Tauri，请安装系统级 Node 20。

### 安装 Node.js 20 LTS

1. 打开 https://nodejs.org/
2. 下载 **20 LTS** 安装包
3. 安装时勾选 **Add to PATH**

### 启用 pnpm

PowerShell（管理员）：

```powershell
corepack enable
corepack prepare pnpm@10 --activate
```

### 验证

```powershell
where.exe node
# 应为 C:\Program Files\nodejs\node.exe 等系统路径，而非 .cursor-server

node --version    # v20.x
pnpm --version    # 10.x
```

若 `node` 指向 IDE 内置路径，调整系统 **PATH**，让 `C:\Program Files\nodejs` 优先于 IDE 相关目录。

---

## 3. WebView2 Runtime

Tauri 2 在 Windows 上使用系统 **WebView2** 渲染前端（Linux 上对应 webkit2gtk，Windows **无需**单独安装 GTK/WebKit）。

- Windows 10（较新版本）/ 11 通常已自带 Evergreen WebView2
- 若 `pnpm tauri dev` 报 WebView2 缺失，安装 [Evergreen Bootstrapper](https://developer.microsoft.com/microsoft-edge/webview2/)

### 验证（可选）

设置 → 应用 → 已安装的应用，搜索 **Microsoft Edge WebView2**，或运行 `pnpm tauri dev` 看是否报 WebView2 错误。

---

## 4. 一次性环境自检

环境装完后在 **PowerShell** 执行：

```powershell
Write-Host "=== Rust ==="
rustc --version
cargo --version

Write-Host "=== Node ==="
where.exe node
node --version
pnpm --version

Write-Host "=== MSVC ==="
where.exe link
if (-not $?) { Write-Host "link.exe: MISSING（请安装 VS Build Tools）" }
```

全部正常即可克隆/进入项目目录。

---

## 5. 本机 SSH 测试服务（联调必备）

MVP 需要能 SSH 到测试机；开发阶段常用 **本机 OpenSSH 服务器**。

### 安装 OpenSSH 服务器

**设置 → 应用 → 可选功能 → 添加功能**，搜索并安装 **OpenSSH 服务器**。

### 启动并设为自动启动

PowerShell（管理员）：

```powershell
Start-Service sshd
Set-Service -Name sshd -StartupType Automatic
Get-Service sshd
```

### 确认监听

```powershell
netstat -an | findstr ":22"
```

### 允许密码登录

编辑 `C:\ProgramData\ssh\sshd_config`，确保包含：

```
PasswordAuthentication yes
```

修改后重启服务：

```powershell
Restart-Service sshd
```

### 测试账号

- 使用本机 Windows 用户名
- 确保该账户已设置 **登录密码**（MVP 仅支持密码认证）
- 若使用 Microsoft 账户登录，需为本地账户单独设置密码

命令行快速测连通：

```powershell
ssh 你的用户名@127.0.0.1
```

能登录 shell 即表示 SSH 服务正常。

### 可选：Docker 测试容器

已安装 Docker Desktop 时：

```powershell
docker run -d --name ssh-test -p 2222:22 `
  -e PASSWORD_ACCESS=true -e USER_PASSWORD=secret `
  linuxserver/openssh-server
# 连接时 Port 填 2222，密码 secret
```

---

## 6. 项目依赖与首次启动

假设项目已克隆到 `D:\Codes\miterm`（按实际路径修改）：

```powershell
cd D:\Codes\miterm
pnpm install
```

首次编译会下载 Rust crates 并编译 C 依赖（libssh2 等），耗时数分钟属正常。

### 开发模式（GUI 联调）

```powershell
pnpm tauri dev
```

弹出 miterm 窗口 → **环境安装完成**。联调验收见 [使用与Windows联调说明 §5](使用与Windows联调说明.md#5-windows-gui-联调步骤)。

### 仅编译检查（不依赖 SSH 联调）

```powershell
pnpm run build
cd src-tauri
cargo build
cargo clippy -- -D warnings   # 可选
```

### Release 打包（可选）

```powershell
cd D:\Codes\miterm
pnpm tauri build
```

产物位于 `src-tauri\target\release\bundle\`（`.msi` / `.exe` 等，视配置而定）。

---

## 7. 与 Linux 安装清单的对照

| Linux（[环境安装清单.md](环境安装清单.md)） | Windows 对应 |
|---------------------------------------------|--------------|
| `build-essential`（gcc/make） | VS Build Tools → MSVC + Windows SDK |
| `libwebkit2gtk-4.1-dev` | 系统 WebView2（无需 GTK） |
| `libssh2-1-dev`、`libssl-dev` | `libssh2-sys` 等在 `cargo build` 时自动编译/链接，一般无需手动装 dev 包 |
| `pkg-config` 验证 webkit/libssh2 | 不需要；改用 §4 自检脚本 |
| `apt install openssh-server` | 可选功能 → OpenSSH 服务器 |
| `xvfb-run`（无桌面远程开发） | Windows 有桌面，直接 `pnpm tauri dev` |

---

## 8. 常见问题

| 现象 | 处理 |
|------|------|
| `link.exe` not found / LNK 错误 | 安装 VS Build Tools（§0），重启终端；或在「x64 Native Tools Command Prompt」中运行 |
| `cargo: command not found` | 将 `%USERPROFILE%\.cargo\bin` 加入 PATH，重开终端 |
| `node` 指向 cursor-server / IDE 路径 | 调整 PATH，让 `C:\Program Files\nodejs` 优先 |
| WebView2 缺失 | 安装 [Evergreen WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) |
| `libssh2-sys` / OpenSSL 编译失败 | 确认 MSVC 已装；可安装 [vcpkg](https://vcpkg.io/) 并按 [ssh2 crate 文档](https://docs.rs/ssh2/latest/ssh2/) 配置 |
| `pnpm tauri dev` 报缺少 MSVC | 同 `link.exe` 问题 |
| SSH Authentication failed | 确认 `PasswordAuthentication yes`、测试账户有密码 |
| 连接一直 Connecting | 防火墙是否拦 22 端口；先用 `ssh 用户@127.0.0.1` 验证 |
| Rust 下载超时 | 使用 [§1 国内镜像](#可选rustup-国内镜像) |

---

## 9. 与三平台发布的关系（备忘）

| 目标 | 构建环境 |
|------|----------|
| Windows 包 | 当前 Windows 本机 `pnpm tauri build` |
| Linux 包 | 需 Ubuntu 等 Linux 环境或 CI `ubuntu-latest` |
| macOS 包 | 需 macOS 或 CI `macos-latest` |

在 Windows 上可完整进行 **GUI 开发联调** 与 **Windows 打包**；Linux/macOS 包需另备环境，见 [开发文档](开发文档.md#后续扩展)。

---

## 10. 参考链接

- [Tauri 2 — Windows 前置条件](https://v2.tauri.app/start/prerequisites/)
- [OpenSSH for Windows](https://learn.microsoft.com/windows-server/administration/openssh/openssh_install_firstuse)
- [rustup 安装](https://www.rust-lang.org/tools/install)
- [Node.js 20 LTS](https://nodejs.org/)
