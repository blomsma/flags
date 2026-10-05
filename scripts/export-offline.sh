#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p transfer
docker buildx build --platform linux/amd64 --load -t event-flags:1.0.0 .
docker image save -o transfer/images.tar event-flags:1.0.0
echo 'Kopieer de hele repo inclusief transfer/images.tar naar de NUC.'
echo 'Daar: docker image load -i transfer/images.tar en bash scripts/start.sh --offline'
