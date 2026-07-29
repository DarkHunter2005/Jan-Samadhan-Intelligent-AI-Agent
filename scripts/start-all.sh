#!/usr/bin/env bash
# Starts the ML service and the Node backend, waits until both are healthy.
#
#   ./scripts/start-all.sh           start both services
#   ./scripts/start-all.sh --seed    start both, then reseed the database
#
# Logs: /tmp/ml.log and /tmp/api.log
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ML_PORT="${ML_PORT:-8000}"
API_PORT="${API_PORT:-4000}"
WEB_PORT="${WEB_PORT:-5173}"
WITH_WEB="${WITH_WEB:-1}"   # set WITH_WEB=0 to skip the React dev server

stop_port() {
  local port=$1
  local pids
  pids=$(ss -lptnH "sport = :$port" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u)
  [ -n "$pids" ] && kill $pids 2>/dev/null && sleep 1
  return 0
}

wait_for() {
  local url=$1 name=$2 tries=${3:-60}
  for ((i = 1; i <= tries; i++)); do
    if curl -sf -m 2 "$url" > /dev/null 2>&1; then
      echo "  $name ready (${i}s)"
      return 0
    fi
    sleep 1
  done
  echo "  ERROR: $name did not become ready" >&2
  return 1
}

echo "[1/4] stopping anything on ports $ML_PORT / $API_PORT / $WEB_PORT"
stop_port "$ML_PORT"
stop_port "$API_PORT"
stop_port "$WEB_PORT"

echo "[2/4] starting ML service (port $ML_PORT)"
cd "$ROOT/ml-service"
[ -f models/category_model.joblib ] || { echo "  training models first..."; python3 train.py; }
setsid python3 -m uvicorn app.main:app --host 127.0.0.1 --port "$ML_PORT" \
  > /tmp/ml.log 2>&1 < /dev/null &
wait_for "http://127.0.0.1:$ML_PORT/health" "ML service" || { tail -20 /tmp/ml.log; exit 1; }

echo "[3/4] starting backend (port $API_PORT)"
cd "$ROOT/backend"
[ -d node_modules ] || npm install --silent
if [ "${1:-}" = "--seed" ]; then
  echo "  seeding database..."
  npm run seed 2>&1 | sed 's/^/  /'
fi
SUBMIT_RATE_LIMIT="${SUBMIT_RATE_LIMIT:-20}" setsid node src/server.js > /tmp/api.log 2>&1 < /dev/null &
wait_for "http://127.0.0.1:$API_PORT/api/health" "backend" || { tail -20 /tmp/api.log; exit 1; }

if [ "$WITH_WEB" = "1" ]; then
  echo "[4/4] starting React dev server (port $WEB_PORT)"
  cd "$ROOT/frontend"
  [ -d node_modules ] || npm install --silent
  setsid npx vite --port "$WEB_PORT" --host 127.0.0.1 > /tmp/web.log 2>&1 < /dev/null &
  wait_for "http://127.0.0.1:$WEB_PORT/" "React app" || { tail -20 /tmp/web.log; exit 1; }
else
  echo "[4/4] skipping React dev server (WITH_WEB=0)"
fi

echo
echo "======================================================"
echo "  Portal      : http://localhost:$WEB_PORT"
echo "  Backend API : http://localhost:$API_PORT/api/health"
echo "  ML API docs : http://localhost:$ML_PORT/docs"
echo "======================================================"
echo "  Demo logins (password: password123)"
echo "    citizen : ravi@example.com"
echo "    officer : kseb@gov.in"
echo "    admin   : admin@gov.in"
echo "======================================================"
echo "  Logs: /tmp/ml.log  /tmp/api.log  /tmp/web.log"
