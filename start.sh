#!/usr/bin/env bash
# start.sh — local dev: FastAPI on :8000, Vite on :5173.
#
# Usage:
#   ./start.sh            # start both (backend + frontend)
#   ./start.sh backend    # backend only
#   ./start.sh frontend   # frontend only
#   ./start.sh setup      # install deps (Python venv + npm) and exit
#
# First run: ./start.sh setup, then ./start.sh.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

VENV_DIR="$ROOT_DIR/.venv"
PY_BIN="${PYTHON:-python3}"

setup() {
  echo "==> Setting up Python venv at $VENV_DIR"
  if [ ! -d "$VENV_DIR" ]; then
    "$PY_BIN" -m venv "$VENV_DIR"
  fi
  # shellcheck disable=SC1091
  source "$VENV_DIR/bin/activate"
  pip install --upgrade pip >/dev/null
  pip install -r requirements.txt
  pip install "uvicorn[standard]"

  echo "==> Installing frontend deps"
  (cd frontend && npm install)

  echo "==> Done. Run ./start.sh to launch dev servers."
}

start_backend() {
  if [ ! -d "$VENV_DIR" ]; then
    echo "Python venv missing. Run: ./start.sh setup"
    exit 1
  fi
  # shellcheck disable=SC1091
  source "$VENV_DIR/bin/activate"
  echo "==> FastAPI on http://127.0.0.1:8000"
  exec uvicorn --app-dir api index:app --reload --host 127.0.0.1 --port 8000
}

start_frontend() {
  if [ ! -d frontend/node_modules ]; then
    echo "Frontend deps missing. Run: ./start.sh setup"
    exit 1
  fi
  echo "==> Vite on http://127.0.0.1:5173"
  exec npm --prefix frontend run dev -- --host 127.0.0.1
}

start_both() {
  if [ ! -d "$VENV_DIR" ] || [ ! -d frontend/node_modules ]; then
    echo "Dependencies missing. Running setup first…"
    setup
  fi

  trap 'echo "Stopping…"; kill 0' EXIT INT TERM

  (
    # shellcheck disable=SC1091
    source "$VENV_DIR/bin/activate"
    echo "==> FastAPI on http://127.0.0.1:8000"
    uvicorn --app-dir api index:app --reload --host 127.0.0.1 --port 8000
  ) &

  (
    echo "==> Vite on http://127.0.0.1:5173"
    npm --prefix frontend run dev -- --host 127.0.0.1
  ) &

  wait
}

case "${1:-both}" in
  setup)    setup ;;
  backend)  start_backend ;;
  frontend) start_frontend ;;
  both|"")  start_both ;;
  *)
    echo "Usage: $0 [setup|backend|frontend|both]"
    exit 1
    ;;
esac
