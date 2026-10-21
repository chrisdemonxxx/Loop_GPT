#requires -Version 5.1
<#
.SYNOPSIS
    Bring up the full Loop-it stack locally with Docker.

.DESCRIPTION
    The no-dependency preview (scripts/preview.ps1) runs the API with an
    in-process run manager and no sandbox. This script is the real thing:
    Postgres, Temporal, router, scheduler, workspace-dispatch, egress and
    preview proxies, billing, domains, app-proxy, orchestrator, api, web,
    admin, and observability - the same services docker-compose.yml runs in
    production, on your machine.

    Prerequisites:
      - Docker Desktop running (docker info answers)
      - HF_TOKEN set (User scope or session) for live model calls
      - .env present (run: uv run python scripts/generate_secrets.py)

    What it does, in order:
      1. Verifies the Docker daemon answers.
      2. Stops the no-Docker preview if it is still holding ports 8000/5173.
      3. Points LOOPIT_MODEL_API_KEY at the HF token (the router uses it as
         the upstream credential) and fills HF_TOKEN for the api container.
         Backs up .env to .env.bak first.
      4. Builds the sandbox image (loopit-sandbox:latest) the scheduler
         launches agent work into.
      5. docker compose up -d --build (first build is slow: ~15 images).
      6. Waits for api + web health, then prints the URLs.

.PARAMETER SkipBuild
    Skip image builds and reuse existing ones (fast restart).

.EXAMPLE
    powershell -File scripts/local-full-stack.ps1
#>
[CmdletBinding()]
param([switch]$SkipBuild)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

# Docker Desktop writes a benign "No memory limit support" warning to stderr
# on every call. Under PS 5.1 with EAP=Stop, ANY stderr from a native command
# becomes a terminating NativeCommandError — even when redirected. All docker
# invocations therefore go through this helper, which scopes EAP=Continue and
# returns the real exit code.
function Invoke-Docker {
    # No param() block on purpose: docker flags like -d and --build must land
    # in $args untouched instead of binding to this function.
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        docker @args 2>&1 | Out-Host
        return $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $saved
    }
}

Write-Host "== Loop-it full local stack ==" -ForegroundColor Cyan

# 1. Docker daemon
if ((Invoke-Docker info) -ne 0) {
    throw "Docker daemon is not answering. Start Docker Desktop and wait for the whale icon to go steady."
}
Write-Host "[1/6] Docker daemon: ok"

# 2. Stop the no-Docker preview if it holds our ports
foreach ($port in @(8000, 5173)) {
    $conn = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($conn) {
        Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
        Write-Host "      stopped preview process on port $port (pid $($conn.OwningProcess))"
    }
}
Write-Host "[2/6] preview ports clear"

# 3. Live model credentials in .env (gitignored; backed up first)
$envFile = Join-Path $repo '.env'
if (-not (Test-Path $envFile)) {
    throw ".env missing. Run: uv run python scripts/generate_secrets.py"
}
$hf = [Environment]::GetEnvironmentVariable('HF_TOKEN', 'User')
if (-not $hf) { $hf = $env:HF_TOKEN }
if (-not $hf) { throw "HF_TOKEN not found in User scope or session env." }

Copy-Item $envFile "$envFile.bak" -Force
$text = Get-Content $envFile -Raw
# router-svc resolves every route's credential_ref to LOOPIT_MODEL_API_KEY and
# sends it as the upstream bearer - for the HF router upstream that means the
# HF token itself. The api container needs HF_TOKEN present so it boots live
# (offline=false) and defaults to orchestrator execution mode.
$text = $text -replace '(?m)^LOOPIT_MODEL_API_KEY=.*$', "LOOPIT_MODEL_API_KEY=$hf"
$text = $text -replace '(?m)^HF_TOKEN=.*$', "HF_TOKEN=$hf"
if ($text -notmatch '(?m)^HF_TOKEN=') { $text += "`nHF_TOKEN=$hf`n" }
# Local DNS runs on the in-memory provider: no real Cloudflare account needed
# on localhost. The compose file still requires the variables to be non-empty,
# so they get explicit local placeholders.
if ($text -notmatch '(?m)^LOOPIT_DOMAINS_DNS_PROVIDER=') { $text += "`nLOOPIT_DOMAINS_DNS_PROVIDER=memory`n" }
if ($text -notmatch '(?m)^LOOPIT_DOMAINS_ALLOW_FAKE_PROVIDERS=') { $text += "LOOPIT_DOMAINS_ALLOW_FAKE_PROVIDERS=1`n" }
if ($text -notmatch '(?m)^CLOUDFLARE_API_TOKEN=.+') { $text += "CLOUDFLARE_API_TOKEN=local-dev-unused`n" }
if ($text -notmatch '(?m)^CLOUDFLARE_ACCOUNT_ID=.+') { $text += "CLOUDFLARE_ACCOUNT_ID=local-dev-unused`n" }
Set-Content $envFile $text -NoNewline -Encoding utf8
Write-Host "[3/6] .env: live model credentials + local DNS provider set (backup at .env.bak)"

# 4. Sandbox image the scheduler launches agent work into
if (-not $SkipBuild) {
    if ((Invoke-Docker build -f sandbox/image/Dockerfile -t loopit-sandbox:latest .) -ne 0) {
        throw "sandbox image build failed"
    }
}
Write-Host "[4/6] sandbox image: loopit-sandbox:latest"

# 5. Full stack
if ($SkipBuild) {
    $composeCode = Invoke-Docker compose up -d
} else {
    $composeCode = Invoke-Docker compose up -d --build
}
if ($composeCode -ne 0) { throw "docker compose up failed" }
Write-Host "[5/6] compose stack started (first build takes a while)"

# 6. Wait for the user-facing services
$deadline = (Get-Date).AddMinutes(8)
$apiUp = $false; $webUp = $false
while ((Get-Date) -lt $deadline -and -not ($apiUp -and $webUp)) {
    Start-Sleep -Seconds 5
    if (-not $apiUp) {
        try {
            $h = Invoke-RestMethod 'http://127.0.0.1:8000/api/health' -TimeoutSec 3
            $apiUp = ($h.status -eq 'ok')
        } catch {}
    }
    if (-not $webUp) {
        try {
            $null = Invoke-WebRequest 'http://127.0.0.1:8080/' -TimeoutSec 3 -UseBasicParsing
            $webUp = $true
        } catch {}
    }
}
if (-not $apiUp) { throw "api did not become healthy - check: docker compose logs api" }
if (-not $webUp) { throw "web did not become healthy - check: docker compose logs web" }
Write-Host "[6/6] api + web healthy"

$health = Invoke-RestMethod 'http://127.0.0.1:8000/api/health' -TimeoutSec 5
Write-Host ""
Write-Host "== Loop-it full stack is up ==" -ForegroundColor Green
Write-Host "  Web UI:    http://localhost:8080"
Write-Host "  API:       http://localhost:8000  (offline=$($health.offline), execution=$($health.run_execution_mode))"
Write-Host "  Admin:     http://localhost:8081"
Write-Host "  Grafana:   http://localhost:3000"
Write-Host ""
Write-Host "First run: register an account in the UI (real Postgres auth now),"
Write-Host "then start a run. The agent executes inside loopit-sandbox containers"
Write-Host "with default-deny egress; checkpoints are restorable snapshots."
Write-Host "Stop everything: docker compose down"
