#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
command -v docker >/dev/null || { echo 'Installeer eerst Docker met de Compose-plugin; zie README.md.' >&2; exit 1; }
docker compose version >/dev/null
docker info >/dev/null 2>&1 || { echo 'Docker is niet gestart of je hebt geen toegang tot Docker.' >&2; exit 1; }
[[ -f .env ]] || cp .env.example .env
if [[ "${1:-}" == '--offline' ]]; then
  docker compose up -d --no-build --pull never --wait --wait-timeout 120
else
  docker compose up -d --build --wait --wait-timeout 180
fi
docker compose ps
echo 'Open de poort uit .env in je browser (standaard 4174).'
