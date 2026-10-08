#!/usr/bin/env bash
# One command to run the whole thing on this Mac: the app server and the Electron overlay. The app
# server starts the model servers it needs itself (llama.cpp, whisper.cpp — src/local-servers.js),
# after Setup has chosen and downloaded a model, and stops them when it stops.
# --services-only: start the app server but not the overlay, and stay up while the parent process
# lives — Cue.app runs this from its bundled copy (CUE_NODE is its own binary, logs and data live
# outside the bundle).
set -uo pipefail
cd "$(dirname "$0")/.."
SERVICES_ONLY=0; [ "${1:-}" = "--services-only" ] && SERVICES_ONLY=1
NODE="${CUE_NODE:-node}"
export CUE_LOG_DIR="${CUE_LOG_DIR:-logs}"
DATA_FILE="${CUE_DATA_FILE-data/store.json}"   # set but empty: persistence off
APP_PORT="${PORT:-8787}"
STARTED=()

# macOS helpers, built here from source once (and again when the source changes): screen-text
# (Vision reads the screenshot), pdf-text (PDFKit reads mode-file PDFs) and system-audio (the other
# side of the call, and its permission).
for src in native/*.swift; do
  bin="bin/$(basename "$src" .swift)"
  if [ -f "$src" ] && command -v swiftc >/dev/null 2>&1 && [ "$src" -nt "$bin" ]; then
    mkdir -p bin && swiftc -O "$src" -o "$bin" 2>/dev/null || echo "[start] could not build $bin; Cue runs without it" >&2
  fi
done

healthy() { curl -sf -m 1 "http://127.0.0.1:$1/health" >/dev/null 2>&1; }

cleanup() {
  # TERM lets the app server stop the model servers it started.
  for pid in "${STARTED[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null; done
  for pid in "${STARTED[@]:-}"; do
    for _ in $(seq 25); do { [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; } || break; sleep 0.2; done
  done
}
trap cleanup EXIT INT TERM

mkdir -p "$CUE_LOG_DIR"
[ -n "$DATA_FILE" ] && mkdir -p "$(dirname "$DATA_FILE")"

# An app server already on the port is not reused: it may be running other code, and the overlay
# would silently talk to it.
if healthy "$APP_PORT"; then echo "[start] port $APP_PORT is already serving something; stop it or set PORT" >&2; exit 1; fi
echo "[start] launching app server on :$APP_PORT"
ELECTRON_RUN_AS_NODE=1 "$NODE" src/server.js >"$CUE_LOG_DIR/server.log" 2>&1 &
SERVER_PID=$!
STARTED+=("$SERVER_PID")
until healthy "$APP_PORT"; do
  kill -0 "$SERVER_PID" 2>/dev/null || { echo "[start] app server exited; last lines of $CUE_LOG_DIR/server.log:" >&2; tail -5 "$CUE_LOG_DIR/server.log" >&2; exit 1; }
  sleep 0.2
done

if [ "$SERVICES_ONLY" = 1 ]; then
  echo "[start] services ready"
  # Outlive nothing: when the app quits (or crashes), stop what this script started.
  while kill -0 "$PPID" 2>/dev/null; do sleep 1 & wait $!; done   # wait: a TERM lands at once
  exit 0
fi

( cd client && { [ -d node_modules ] || npm install --silent; } )
# ceiling: electron's postinstall unzips with extract-zip, which silently does nothing under Node 26
# (the promise never settles and the process exits 0); unzip the cached archive ourselves until
# electron's installer works on the Node in use.
if [ ! -f client/node_modules/electron/path.txt ]; then
  zip="$(find "$HOME/Library/Caches/electron" -name "electron-v$(node -p "require('./client/node_modules/electron/package.json').version")-darwin-$(uname -m)*.zip" 2>/dev/null | head -1)"
  [ -n "$zip" ] || { node client/node_modules/electron/install.js; zip="$(find "$HOME/Library/Caches/electron" -name 'electron-v*-darwin-*.zip' | head -1)"; }
  unzip -q -o "$zip" -d client/node_modules/electron/dist && printf 'Electron.app/Contents/MacOS/Electron' > client/node_modules/electron/path.txt \
    || { echo "[start] could not install the Electron binary" >&2; exit 1; }
fi

echo "[start] launching Electron overlay"
CUE_SERVER_URL="http://localhost:$APP_PORT" npm --prefix client start

echo "[start] overlay closed; stopping the app server and the model servers it started"
