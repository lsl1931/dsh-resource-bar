#!/usr/bin/env bash
# Boot a throwaway host and inspect this plugin's row in the REAL boot graph.
#
# Companion to e2e-mount.sh, focused on the one link the in-process suites
# cannot reach: the `window.__DSH_BOOT__` entry that makes the client module
# system materialize this plugin at all. Uses its own port and its own scratch
# DSH_HOME; the user's profile is never touched.
set -uo pipefail

PORT="${1:-3098}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_BIN="${DSH_BIN:-dsh}"
SCRATCH="$(mktemp -d /tmp/dsh-rb-boot-XXXXXX)"

# Identify the server by port holder: this platform's dsh renames its main
# thread, so `pgrep node` does not match it.
port_pids() {
  ss -lntp 2>/dev/null | grep -F ":$PORT " | grep -o "pid=[0-9]*" | cut -d= -f2 | sort -u
}
cleanup() {
  local p
  for p in $(port_pids); do kill -TERM "$p" 2>/dev/null; done
  for _ in $(seq 1 15); do [[ -z "$(port_pids)" ]] && break; sleep 1; done
  for p in $(port_pids); do kill -KILL "$p" 2>/dev/null; done
  [[ "$SCRATCH" == /tmp/dsh-rb-boot-* ]] && rm -rf "$SCRATCH"
}
trap cleanup EXIT

if ss -lnt 2>/dev/null | grep -q ":$PORT "; then
  echo "port $PORT is already in use; pass a free port"
  exit 1
fi

export DSH_HOME="$SCRATCH"
mkdir -p "$SCRATCH/profiles"
(cd "$SCRATCH" && "$DSH_BIN" plugin --profile web add "$REPO" >/dev/null 2>&1) || { echo "install failed"; exit 1; }
(cd "$SCRATCH" && setsid "$DSH_BIN" web --no-open --port "$PORT" >"$SCRATCH/web.log" 2>&1 </dev/null &)
for _ in $(seq 1 60); do ss -lnt 2>/dev/null | grep -q ":$PORT " && break; sleep 1; done

TOKEN=""
for _ in $(seq 1 30); do
  TOKEN="$(grep -o 'token=[A-Za-z0-9_-]*' "$SCRATCH/web.log" 2>/dev/null | tail -1 | cut -d= -f2)"
  [[ -n "$TOKEN" ]] && break
  sleep 1
done
[[ -n "$TOKEN" ]] || { echo "no launch token"; tail -20 "$SCRATCH/web.log"; exit 1; }

node "$REPO/scripts/e2e-boot-graph.mjs" "$PORT" "$TOKEN"
