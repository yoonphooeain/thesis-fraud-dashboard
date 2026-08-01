#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$PROJECT_ROOT/scripts/backend_env.sh"
cd "$PROJECT_ROOT/backend"

if [[ ! -x .venv/bin/uvicorn ]]; then
  echo "Run ./scripts/setup_backend.sh first."
  exit 1
fi

exec .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
