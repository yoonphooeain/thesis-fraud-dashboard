#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_ROOT="$PROJECT_ROOT/backend"
LOCAL_OMP="$BACKEND_ROOT/.runtime/extracted/lib"

if [[ -d "$LOCAL_OMP" ]]; then
  export DYLD_LIBRARY_PATH="$LOCAL_OMP${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}"
elif command -v brew >/dev/null 2>&1; then
  BREW_OMP="$(brew --prefix libomp 2>/dev/null || true)"
  if [[ -n "$BREW_OMP" ]]; then
    export DYLD_LIBRARY_PATH="$BREW_OMP/lib${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}"
  fi
	fi
