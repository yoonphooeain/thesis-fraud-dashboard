#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# vinext uses fs.promises.glob, which requires Node.js 22 or newer.
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
CODEX_NODE_BIN="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin"
if (( NODE_MAJOR < 22 )) && [[ -x "$CODEX_NODE_BIN/node" ]]; then
  export PATH="$CODEX_NODE_BIN:$PATH"
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
fi

if (( NODE_MAJOR < 22 )); then
  echo "NexaGift requires Node.js 22 or newer. Current version: $(node --version 2>/dev/null || echo unavailable)"
  exit 1
fi

./scripts/run_backend.sh &
BACKEND_PID=$!

cleanup() {
  kill "$BACKEND_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "NexaGift API: http://127.0.0.1:8000/docs"
echo "NexaGift website: http://127.0.0.1:3000"
npm run dev
