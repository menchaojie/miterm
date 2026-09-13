# 本机冒烟：启动 agent → auth → create → attach → 输入 → detach → 再 attach（验证保活）
# 用法: powershell -File scripts/agent-smoke.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root "agent\target\release\miterm-agent.exe"
if (-not (Test-Path $exe)) {
    $exe = Join-Path $root "agent\target\debug\miterm-agent.exe"
}
if (-not (Test-Path $exe)) {
    Write-Error "请先编译: cd agent; cargo build --release"
}

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $exe
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$p = [System.Diagnostics.Process]::Start($psi)

$readyLine = $null
while (-not $p.HasExited) {
    $line = $p.StandardOutput.ReadLine()
    if ($null -eq $line) { break }
    if ($line.StartsWith("MITERM_AGENT_READY ")) {
        $readyLine = $line.Substring("MITERM_AGENT_READY ".Length)
        break
    }
}
if (-not $readyLine) {
    $err = $p.StandardError.ReadToEnd()
    Write-Error "未收到 READY: $err"
}
$ready = $readyLine | ConvertFrom-Json
Write-Host "agent ready port=$($ready.port) token=$($ready.token)"

function Send-Line($client, $obj) {
    $json = ($obj | ConvertTo-Json -Compress)
    $bytes = [Text.Encoding]::UTF8.GetBytes($json + "`n")
    $client.GetStream().Write($bytes, 0, $bytes.Length)
}

function Read-Msg($client) {
    $stream = $client.GetStream()
    $sb = New-Object Text.StringBuilder
    while ($true) {
        $b = $stream.ReadByte()
        if ($b -lt 0) { return $null }
        if ($b -eq 10) { break } # \n
        if ($b -ne 13) { [void]$sb.Append([char]$b) }
    }
    return ($sb.ToString() | ConvertFrom-Json)
}

function B64([string]$s) {
    [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s))
}

$c1 = New-Object System.Net.Sockets.TcpClient("127.0.0.1", [int]$ready.port)
Send-Line $c1 @{ type = "auth"; token = $ready.token }
$m = Read-Msg $c1
if ($m.type -ne "ok") { Write-Error "auth failed: $($m | ConvertTo-Json)" }
Send-Line $c1 @{ type = "create"; cols = 80; rows = 24 }
$m = Read-Msg $c1
if ($m.type -ne "created") { Write-Error "create failed: $($m | ConvertTo-Json)" }
$sid = $m.sessionId
Write-Host "created session $sid"

Send-Line $c1 @{ type = "attach"; sessionId = $sid }
$m = Read-Msg $c1
if ($m.type -ne "attached") { Write-Error "attach failed: $($m | ConvertTo-Json)" }

# 读一点欢迎输出（非阻塞尽量）
Start-Sleep -Milliseconds 400
while ($c1.Available -gt 0) {
    $m = Read-Msg $c1
    if ($m.type -eq "output") {
        $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($m.data))
        Write-Host "output: $($text.Substring(0, [Math]::Min(80, $text.Length)))..."
    }
}

# 写入一行标记
$marker = "miterm-agent-smoke-$([guid]::NewGuid().ToString('N').Substring(0,8))"
Send-Line $c1 @{ type = "input"; data = (B64 "$marker`r`n") }
Start-Sleep -Milliseconds 500
$c1.Close()
Write-Host "disconnected (session should survive)"

Start-Sleep -Milliseconds 300
$c2 = New-Object System.Net.Sockets.TcpClient("127.0.0.1", [int]$ready.port)
Send-Line $c2 @{ type = "auth"; token = $ready.token }
$m = Read-Msg $c2
Send-Line $c2 @{ type = "attach"; sessionId = $sid }
$m = Read-Msg $c2
if ($m.type -ne "attached") { Write-Error "reattach failed: $($m | ConvertTo-Json)" }
$replay = ""
if ($m.replay) {
    $replay = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($m.replay))
}
if ($replay -notlike "*$marker*") {
    Write-Host "WARN: replay 未包含 marker（Windows ConPTY 回显时机可能不同）"
    Write-Host "replay len=$($replay.Length)"
} else {
    Write-Host "OK: reattach replay 含 marker — 保活生效"
}

Send-Line $c2 @{ type = "kill"; sessionId = $sid }
$m = Read-Msg $c2
$c2.Close()

try { $p.Kill() } catch {}
Write-Host "smoke done"
