# Script khởi động Codex MCP Server trên Windows (foreground, xem log trực tiếp)
param(
    [string]$Workspace = $env:WORKSPACE_PATH,
    [int]$Port = 3000,
    [switch]$Force,
    [switch]$OpenUI,
    [switch]$SkipBuild
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

function Get-PortOwnerPid([int]$TargetPort) {
    $lines = netstat -ano | Select-String ":$TargetPort\s" | Select-String "LISTENING"
    foreach ($line in $lines) {
        $parts = ($line -replace '\s+', ' ').ToString().Trim().Split(' ')
        $processId = [int]$parts[-1]
        if ($processId -gt 0) { return $processId }
    }
    return $null
}

function Get-DotEnvValue([string]$Name) {
    if (-not (Test-Path ".env")) { return $null }

    $line = Get-Content ".env" | Where-Object {
        $_ -match "^\s*$Name\s*=" -and -not $_.TrimStart().StartsWith("#")
    } | Select-Object -First 1

    if (-not $line) { return $null }

    $value = ($line -split "=", 2)[1].Trim()
    return $value.Trim("'").Trim('"')
}

if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Write-Host "Da tao file .env - hay chinh sua WORKSPACE_PATH" -ForegroundColor Yellow
}

if (-not $Workspace) {
    $Workspace = Get-DotEnvValue "WORKSPACE_PATH"
}

if (-not $Workspace) {
    $Workspace = $ScriptDir
}

$ChatGptAutoApprove = Get-DotEnvValue "CHATGPT_AUTO_APPROVE"
$FullDiskAccess = Get-DotEnvValue "FULL_DISK_ACCESS"
if (-not $FullDiskAccess) { $FullDiskAccess = "true" }

$env:WORKSPACE_PATH = $Workspace
$env:PORT = $Port
if ($ChatGptAutoApprove) {
    $env:CHATGPT_AUTO_APPROVE = $ChatGptAutoApprove
}

Write-Host ""
Write-Host "=== Codex MCP Server ===" -ForegroundColor Cyan
Write-Host "Default cwd: $Workspace"
if ($FullDiskAccess.ToLowerInvariant() -eq "false") {
    Write-Host "Full machine access: OFF (allowed roots enforced)"
} else {
    Write-Host "Full machine access: ON"
}
if ($ChatGptAutoApprove) { Write-Host "ChatGPT auto-approve: $ChatGptAutoApprove" }
$AdminPort = Get-DotEnvValue "ADMIN_PORT"
if (-not $AdminPort) { $AdminPort = "3001" }
$env:ADMIN_PORT = $AdminPort

Write-Host "Port: $Port"
Write-Host "Admin UI: http://127.0.0.1:$AdminPort/ui"
Write-Host ""

if ($env:OPEN_UI -eq "1" -or $OpenUI) {
    Start-Process "http://127.0.0.1:$AdminPort/ui"
}

$existingPid = Get-PortOwnerPid -TargetPort $Port
if ($existingPid) {
    $proc = Get-Process -Id $existingPid -ErrorAction SilentlyContinue
    $procName = if ($proc) { $proc.ProcessName } else { "unknown" }

    Write-Host "[CANH BAO] Port $Port dang duoc dung boi PID $existingPid ($procName)" -ForegroundColor Yellow

    if ($Force) {
        Write-Host "Dang tat process cu (Force)..." -ForegroundColor Yellow
        Stop-Process -Id $existingPid -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
    } else {
        $answer = Read-Host "Dung server cu va chay lai? (y/n)"
        if ($answer -match '^[yY]') {
            Stop-Process -Id $existingPid -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 1
        } else {
            Write-Host "Huy. Server cu van dang chay tai http://localhost:$Port" -ForegroundColor Red
            exit 1
        }
    }
}

if ($SkipBuild) {
    if (-not (Test-Path (Join-Path $ScriptDir "dist\index.js"))) {
        Write-Host "dist\index.js not found. Run .\start.ps1 without -SkipBuild once to build the server." -ForegroundColor Red
        exit 1
    }
    Write-Host "Using existing dist build; skipped npm run build." -ForegroundColor Green
} elseif (-not (Test-Path (Join-Path $ScriptDir "dist\index.js"))) {
    Write-Host "Building current source before startup..." -ForegroundColor Yellow
    npm run build
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Build failed!" -ForegroundColor Red
        Read-Host "Press Enter to close"
        exit 1
    }
} else {
    Write-Host "Using existing dist build." -ForegroundColor Green
}

Write-Host "Khoi dong server (log hien ben duoi)..." -ForegroundColor Green
Write-Host "Nhan Ctrl+C de dung server" -ForegroundColor DarkGray
Write-Host ""

& node dist/index.js
$exitCode = $LASTEXITCODE

Write-Host ""
if ($exitCode -ne 0) {
    Write-Host "Server loi (exit code: $exitCode)" -ForegroundColor Red
} else {
    Write-Host "Server da dung." -ForegroundColor Yellow
}

exit $exitCode
