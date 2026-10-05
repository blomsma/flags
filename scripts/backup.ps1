$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
New-Item -ItemType Directory -Force backups | Out-Null
$destination = (Resolve-Path backups).Path
$archive = 'flags-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.tar.gz'
& docker compose stop flags
if ($LASTEXITCODE -ne 0) { throw 'Stoppen mislukt.' }
try {
    & docker compose run --rm --no-deps --user 0 -v "${destination}:/backup" --entrypoint tar flags -czf "/backup/$archive" -C /app/data .
    if ($LASTEXITCODE -ne 0) { throw 'Back-up mislukt.' }
    Write-Output "Back-up: backups/$archive"
} finally { & docker compose start flags }
