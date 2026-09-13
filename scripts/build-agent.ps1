# 构建本机（Windows）miterm-agent，用于协议调试与冒烟
# 用法: powershell -File scripts/build-agent.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location (Join-Path $root "agent")
cargo build --release
$exe = Join-Path $root "agent\target\release\miterm-agent.exe"
Write-Host "OK: $exe"
& $exe --version
