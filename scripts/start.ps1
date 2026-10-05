param([switch]$Offline)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Installeer Docker Desktop; zie README.md.' }
& docker compose version
if ($LASTEXITCODE -ne 0) { throw 'Docker Compose ontbreekt.' }
& docker info *> $null
if ($LASTEXITCODE -ne 0) { throw 'Start Docker Desktop met Linux-containers.' }
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
if ($Offline) { & docker compose up -d --no-build --pull never --wait --wait-timeout 120 }
else { & docker compose up -d --build --wait --wait-timeout 180 }
if ($LASTEXITCODE -ne 0) { throw 'Opstarten mislukt. Bekijk docker compose logs.' }
& docker compose ps
