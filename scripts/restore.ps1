param([Parameter(Mandatory=$true)][string]$Archive)
$ErrorActionPreference = 'Stop'
$archivePath = (Resolve-Path $Archive).Path
$archiveDir = Split-Path $archivePath -Parent
$archiveName = Split-Path $archivePath -Leaf
Set-Location (Split-Path $PSScriptRoot -Parent)
& docker compose run --rm --no-deps --user 0 -v "${archiveDir}:/backup:ro" --entrypoint tar flags -tzf "/backup/$archiveName" *> $null
if ($LASTEXITCODE -ne 0) { throw 'Back-up kan niet gelezen worden.' }
& "$PSScriptRoot/backup.ps1"
& docker compose stop flags
if ($LASTEXITCODE -ne 0) { throw 'Stoppen mislukt.' }
try {
    & docker compose run --rm --no-deps --user 0 -v "${archiveDir}:/backup:ro" --entrypoint sh flags -c 'tar -xzf "$1" -C /app/data && chown -R node:node /app/data' sh "/backup/$archiveName"
    if ($LASTEXITCODE -ne 0) { throw 'Herstellen mislukt.' }
} finally { & docker compose start flags }
