#!/usr/bin/env sh
# Serves the dashboard at http://localhost:8000 (Web Serial needs localhost or HTTPS).
cd "$(dirname "$0")/web" || exit 1
PORT="${1:-8000}"
echo "Open http://localhost:$PORT in Chrome or Edge. Press Ctrl+C to stop."
if command -v python3 >/dev/null 2>&1; then exec python3 -m http.server "$PORT" --bind 127.0.0.1
elif command -v python >/dev/null 2>&1; then exec python -m http.server "$PORT" --bind 127.0.0.1
elif command -v npx >/dev/null 2>&1; then exec npx --yes serve -l "$PORT" .
else echo "Install Python 3 or Node.js first."; exit 1; fi
