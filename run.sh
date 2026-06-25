#!/usr/bin/env bash
# Start the backend (FastAPI) and frontend (Next.js) together for local development.
# Usage: ./run.sh   (Ctrl-C stops both)
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f backend/.env ]; then
  echo "⚠️  backend/.env not found. Copy backend/.env.example to backend/.env and add your ANTHROPIC_API_KEY."
fi

# Backend (uv-managed venv)
( cd backend && uv run uvicorn server.main:app --reload --port 8000 ) &
BACK=$!

# Frontend
( cd frontend && npm run dev ) &
FRONT=$!

trap 'kill $BACK $FRONT 2>/dev/null' EXIT
echo "Backend  → http://localhost:8000  (docs at /docs)"
echo "Frontend → http://localhost:3000  (admin at /admin)"
wait
