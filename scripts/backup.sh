#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p backups
backup="flags-$(date +%Y%m%d-%H%M%S)-${RANDOM}.tar.gz"
docker compose stop flags
trap 'docker compose start flags' EXIT
docker compose run --rm --no-deps --user 0 -v "$PWD/backups:/backup" --entrypoint tar flags -czf "/backup/$backup" -C /app/data .
echo "Back-up: backups/$backup"
