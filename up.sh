#!/usr/bin/env bash
# One-shot: start SSH server + build all images + start the full stack
# Usage: ./up.sh
set -euo pipefail
cd "$(dirname "$0")"

echo "==> Starting SSH server..."
if ! ss -tln | grep -q ':22 '; then
  sudo systemctl start ssh 2>/dev/null || sudo systemctl start sshd
fi

echo "==> Building images & starting stack (postgres, redis, api, web, workers, reacher, n8n)..."
docker compose up -d --build

echo "==> Status:"
docker compose ps
