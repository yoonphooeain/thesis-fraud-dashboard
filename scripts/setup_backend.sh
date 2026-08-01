#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_ROOT="$PROJECT_ROOT/backend"
PYTHON_BIN="${PYTHON_BIN:-python3}"

cd "$BACKEND_ROOT"
"$PYTHON_BIN" -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/pip install -r requirements.txt

source "$PROJECT_ROOT/scripts/backend_env.sh"
if ! .venv/bin/python -c "import xgboost" >/dev/null 2>&1; then
  if [[ "$(uname -s)" != "Darwin" ]] || ! command -v zstd >/dev/null 2>&1; then
    echo "XGBoost runtime is unavailable. On macOS install libomp and rerun."
    exit 1
  fi
  mkdir -p .runtime/download/unpacked .runtime/extracted
  curl -L --retry 4 --retry-delay 2 \
    -o .runtime/download/llvm-openmp.conda \
    "https://api.anaconda.org/download/conda-forge/llvm-openmp/22.1.8/osx-arm64/llvm-openmp-22.1.8-hc7d1edf_0.conda"
  unzip -o .runtime/download/llvm-openmp.conda -d .runtime/download/unpacked
  zstd -d -f .runtime/download/unpacked/pkg-llvm-openmp-*.tar.zst \
    -o .runtime/download/pkg.tar
  tar -xf .runtime/download/pkg.tar -C .runtime/extracted
  source "$PROJECT_ROOT/scripts/backend_env.sh"
fi

.venv/bin/python -m scripts.prepare_dataset
.venv/bin/python -m scripts.train_models
.venv/bin/pytest -q

echo "Backend setup, training, and tests completed."
