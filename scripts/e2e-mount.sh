#!/usr/bin/env bash
# End-to-end mount verification against a REAL dsh web host.
#
# Why this exists: the unit/selftest suite runs the two halves in-process, which
# cannot catch a boot-time contract violation (an undeclared `ctx.X` read, a
# manifest field the loader rejects). Only a real boot does. This script
# therefore:
#   1. creates a throwaway DSH_HOME under /tmp (your real profile is never
#      touched — that is the whole point);
#   2. installs this plugin into a scratch *web* profile with `dsh plugin add`;
#   3. boots `dsh web` on a free port and waits for readiness;
#   4. exercises the routes over authenticated HTTP: the trust fence, the method
#      check, the live CPU/memory payload, the lazy process ranking and its
#      self-stop;
#   5. confirms the client bundle is actually served inside the boot combo.
#
# Usage:  bash scripts/e2e-mount.sh [port]
# Exits non-zero on the first failure. Leaves nothing running.
set -uo pipefail

PORT="${1:-3099}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH="$(mktemp -d /tmp/dsh-resource-bar-e2e-XXXXXX)"
DSH_BIN="${DSH_BIN:-dsh}"
PASS=0
FAIL=0

# Identify the server by WHO HOLDS THE PORT, not by process name.
# On this platform the dsh process reports its comm as "MainThread" (it renames
# its main thread), so `pgrep -x node` never matches it — that mistake left
# orphaned servers behind during development. `ss -lntp` names the real holder,
# and it also cannot match this script or the user's server on another port.
port_pids() {
  ss -lntp 2>/dev/null | grep -F ":$PORT " | grep -o "pid=[0-9]*" | cut -d= -f2 | sort -u
}

wait_free_or_kill() {
  local pids p
  pids="$(port_pids)"
  [[ -n "$pids" ]] || return 0
  for p in $pids; do kill -TERM "$p" 2>/dev/null; done
  for _ in $(seq 1 15); do
    [[ -z "$(port_pids)" ]] && return 0
    sleep 1
  done
  for p in $(port_pids); do kill -KILL "$p" 2>/dev/null; done
  sleep 1
}

cleanup() {
  wait_free_or_kill
  # Only ever remove the scratch tree this script created.
  [[ "$SCRATCH" == /tmp/dsh-resource-bar-e2e-* ]] && rm -rf "$SCRATCH"
}
trap cleanup EXIT

ok()   { PASS=$((PASS + 1)); printf '  ok  %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
note() { printf '      %s\n' "$1"; }

command -v "$DSH_BIN" >/dev/null || { echo "dsh not found on PATH (set DSH_BIN)"; exit 1; }

if ss -lnt 2>/dev/null | grep -q ":$PORT "; then
  echo "port $PORT is already in use; pass a free port: bash scripts/e2e-mount.sh <port>"
  exit 1
fi

echo "=== 1. scratch home: $SCRATCH ==="
export DSH_HOME="$SCRATCH"
mkdir -p "$SCRATCH/profiles"

echo "=== 2. install the plugin into a scratch web profile ==="
if (cd "$SCRATCH" && "$DSH_BIN" plugin --profile web add "$REPO" >"$SCRATCH/install.log" 2>&1); then
  ok "dsh plugin add succeeded"
else
  bad "dsh plugin add failed"; tail -20 "$SCRATCH/install.log"; exit 1
fi
node -e '
const fs = require("fs");
const p = JSON.parse(fs.readFileSync(process.env.DSH_HOME + "/profiles/web/package.json", "utf8"));
const bundles = p.dsh.profile.bundles;
process.exit(bundles.includes("dsh-resource-bar") ? 0 : 1);
' && ok "the plugin is listed in dsh.profile.bundles" || bad "not listed in dsh.profile.bundles"

echo "=== 3. compose the tree without booting ==="
if "$DSH_BIN" --profile web --dump-config >"$SCRATCH/dump.yml" 2>"$SCRATCH/dump.err"; then
  grep -q "dsh-resource-bar" "$SCRATCH/dump.yml" && ok "composed tree contains the plugin entry" || bad "plugin missing from composed tree"
else
  bad "dump-config failed"; tail -20 "$SCRATCH/dump.err"
fi

echo "=== 4. boot a real dsh web on :$PORT ==="
# `setsid` forks, so the recorded $! is the parent that exits immediately. Launch
# detached and then identify the server by its exact command line, so cleanup
# kills the process that actually holds the port.
(cd "$SCRATCH" && setsid "$DSH_BIN" web --no-open --port "$PORT" >"$SCRATCH/web.log" 2>&1 </dev/null &)
WEB_PID=""
for _ in $(seq 1 30); do
  WEB_PID="$(port_pids | head -1)"
  [[ -n "$WEB_PID" ]] && break
  sleep 1
done
READY=0
for _ in $(seq 1 60); do
  if ss -lnt 2>/dev/null | grep -q ":$PORT "; then READY=1; break; fi
  kill -0 "$WEB_PID" 2>/dev/null || break
  sleep 1
done
if [[ "$READY" == "1" ]]; then
  ok "dsh web came up on :$PORT"
else
  bad "dsh web did not come up"; tail -40 "$SCRATCH/web.log"; exit 1
fi
if grep -qi "failed to apply loader entry\|cannot get property" "$SCRATCH/web.log"; then
  bad "the boot log reports a loader failure"; grep -i -m3 "failed to apply\|cannot get" "$SCRATCH/web.log"
else
  ok "no loader failure in the boot log"
fi

# The listening socket appears before the readiness line is flushed, so wait
# for the token rather than reading the log once.
TOKEN=""
for _ in $(seq 1 30); do
  TOKEN="$(grep -o "token=[A-Za-z0-9_-]*" "$SCRATCH/web.log" 2>/dev/null | tail -1 | cut -d= -f2)"
  [[ -n "$TOKEN" ]] && break
  kill -0 "$WEB_PID" 2>/dev/null || break
  sleep 1
done
if [[ -n "$TOKEN" ]]; then
  ok "launch token captured"
else
  bad "no launch token in the log"; tail -30 "$SCRATCH/web.log"; exit 1
fi

echo "=== 5. exercise the routes over authenticated HTTP ==="
node "$REPO/scripts/e2e-http.mjs" "$PORT" "$TOKEN"
RC=$?
if [[ $RC -eq 0 ]]; then ok "authenticated HTTP contract checks passed"; else bad "HTTP contract checks failed"; fi

echo "=== 6. the real boot graph carries a loadable row for this plugin ==="
node "$REPO/scripts/e2e-boot-graph.mjs" "$PORT" "$TOKEN"
RC2=$?
if [[ $RC2 -eq 0 ]]; then ok "boot-graph row checks passed"; else bad "boot-graph row checks failed"; fi

echo
echo "=== summary ==="
echo "  $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]] || exit 1
echo "  E2E MOUNT PASSED"
