<#
.SYNOPSIS
    Start the Loop-it local preview: API on 8000, web UI on 5173.

.DESCRIPTION
    Runs both halves in their own windows so they outlive whatever started
    them. Nothing here is production: there is no sandbox, so the agent cannot
    execute anything it writes (invariant I1).

.EXAMPLE
    .\scripts\preview.ps1
    Offline mode. The "model" is scripted, so you can judge the interface
    without spending anything.

.EXAMPLE
    $env:HF_TOKEN = "hf_..."; .\scripts\preview.ps1
    Drives the loop with a real model through the Hugging Face router.
#>
[CmdletBinding()]
param(
    [switch]$Live,
    [string]$BillTo = "red-kit"
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot

function Test-PortFree {
    param([int]$Port)
    $inUse = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
    if ($inUse) {
        throw "Port $Port is already in use (PID $($inUse[0].OwningProcess)). Stop it first: Stop-Process -Id $($inUse[0].OwningProcess)"
    }
}

Test-PortFree 8000
Test-PortFree 5173

# A token stored with setx / [Environment]::SetEnvironmentVariable lands in the
# registry, and a shell that was already open never sees it. Reading the User
# scope directly means the token does not silently stop working just because
# the window predates it — which presents identically to having no token.
foreach ($name in "HF_TOKEN", "HF_BILL_TO") {
    if (-not (Get-Item "env:$name" -ErrorAction SilentlyContinue)) {
        $stored = [Environment]::GetEnvironmentVariable($name, "User")
        if ($stored) { Set-Item "env:$name" $stored }
    }
}
if (-not $PSBoundParameters.ContainsKey("BillTo") -and $env:HF_BILL_TO) {
    $BillTo = $env:HF_BILL_TO
}

if ($Live -and -not $env:HF_TOKEN) {
    throw "-Live needs HF_TOKEN. Set it, or drop -Live to use the scripted offline model."
}

# Going live is the default whenever a token exists. Offline has to be asked
# for, because a scripted client that ignores the prompt looks exactly like a
# working product right up until you read what it built.
$goLive = $Live -or [bool]$env:HF_TOKEN
$apiArgs = if ($goLive) { "--bill-to $BillTo" } else { "--offline" }

if (-not $goLive) {
    Write-Host ""
    Write-Host "  HF_TOKEN is not set, so no model will be called." -ForegroundColor Yellow
    Write-Host "  Runs will write the same placeholder file no matter what you type." -ForegroundColor Yellow
    Write-Host "  To build something real:" -ForegroundColor Yellow
    Write-Host "      `$env:HF_TOKEN = 'hf_...'; .\scripts\preview.ps1" -ForegroundColor Yellow
    Write-Host ""
}

$pythonPath = @(
    "apps/api/src",
    "packages/agent-core/src",
    "packages/patch/src",
    "packages/contracts/src",
    "services/router-svc/src"
) -join ";"

Write-Host "Starting API on http://127.0.0.1:8000 ..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList @(
    "-NoExit", "-Command",
    "cd '$repo'; `$env:PYTHONPATH='$pythonPath'; python -m loopit_api $apiArgs --port 8000"
)

Write-Host "Starting web UI on http://localhost:5173 ..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList @(
    "-NoExit", "-Command",
    "cd '$repo\apps\web'; pnpm dev"
)

# The UI is useless until the API answers, so wait for real evidence rather
# than guessing at a sleep duration.
Write-Host "Waiting for both to answer ..." -ForegroundColor DarkGray
$deadline = (Get-Date).AddSeconds(60)
$ready = $false
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 750
    try {
        $health = Invoke-RestMethod "http://127.0.0.1:8000/api/health" -TimeoutSec 2
        $null = Invoke-WebRequest "http://127.0.0.1:5173/" -TimeoutSec 2 -UseBasicParsing
        $ready = $true
        break
    } catch {
        continue
    }
}

if (-not $ready) {
    Write-Host "They did not come up in time. Check the two windows that just opened." -ForegroundColor Red
    exit 1
}

$mode = if ($health.offline) { "offline (scripted model)" } else { "live model, billed to $BillTo" }
Write-Host ""
Write-Host "  Loop-it preview is up - $mode" -ForegroundColor Green
Write-Host "  Open: http://localhost:5173" -ForegroundColor Green
Write-Host ""
Write-Host "  Close the two PowerShell windows to stop it." -ForegroundColor DarkGray
