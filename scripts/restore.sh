#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -f "${1:-}" ]] || { echo 'Gebruik: bash scripts/restore.sh /pad/naar/back-up.tar.gz' >&2; exit 1; }
archive_dir="$(cd "$(dirname "$1")" && pwd)"
archive_name="$(basename "$1")"
# Read the archive before stopping the app; restore only your own trusted backups.
docker compose run --rm --no-deps --user 0 -v "$archive_dir:/backup:ro" --entrypoint tar flags -tzf "/backup/$archive_name" >/dev/null
bash scripts/backup.sh
docker compose stop flags
trap 'docker compose start flags' EXIT
docker compose run --rm --no-deps --user 0 -v "$archive_dir:/backup:ro" --entrypoint sh flags -c 'tar -xzf "$1" -C /app/data && chown -R node:node /app/data' sh "/backup/$archive_name"
echo 'Back-up hersteld. Eerder aanwezige extra mediabestanden blijven behouden.'
