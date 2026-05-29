#!/usr/bin/env bash
# Full-stack smoke test for Quack — brings up the real Compose stack (server +
# Neo4j) reading .env, mints an admin + member token, then (when QUACK_MODEL_* is
# set) delegates the comprehensive per-tool POSITIVE round-trips to the bun driver
# `scripts/smoke-assertions.ts` — proving each MCP tool and each hook actually
# stores and retrieves correct data end-to-end through the real cheap model
# (discover→traverse reads, hook-by-content + META_TOOLS denoise, admin
# data-effect + destructive lifecycle). This script keeps the Compose lifecycle,
# the MODEL gate, and teardown; a non-zero driver exit fails the smoke. Tears the
# stack down on exit.
#
#   bash scripts/smoke-test.sh
#
# Skips cleanly (exit 0) when Docker is unreachable, and SKIPs the comprehensive
# round-trips (still exit 0) when QUACK_MODEL_* is unset. Exits non-zero on any
# assertion failure. Spends a small amount of cheap-model tokens when a model is
# configured (extraction + ask_memory + hook digestion).
# NOTE: no `set -u` — macOS ships bash 3.2, where expanding an empty array
# (`"${arr[@]}"`) under nounset is a fatal "unbound variable" error that `|| true`
# cannot rescue. pipefail + the `:?` guards below cover what we need.
set -o pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PASS=0; FAIL=0
ok() { PASS=$((PASS + 1)); echo "  ✅ $1"; }
no() { FAIL=$((FAIL + 1)); echo "  ❌ $1"; }

command -v docker >/dev/null 2>&1 || { echo "SKIP: docker not found"; exit 0; }
docker info >/dev/null 2>&1 || { echo "SKIP: docker daemon unreachable"; exit 0; }
[ -f .env ] || { echo "FAIL: .env missing (cp .env.example .env and fill it in)"; exit 1; }
set -a; . ./.env; set +a
: "${QUACK_BOOTSTRAP_TOKEN:?QUACK_BOOTSTRAP_TOKEN required in .env}"
: "${QUACK_NEO4J_PASSWORD:?QUACK_NEO4J_PASSWORD required in .env}"
MODEL=0; [ -n "${QUACK_MODEL_API_KEY:-}" ] && [ -n "${QUACK_MODEL_BASE_URL:-}" ] && MODEL=1

ADMIN="$QUACK_BOOTSTRAP_TOKEN"; URL="http://127.0.0.1:7474"
TMPCLIENT="$(mktemp -d)"
cleanup() {
  echo "== teardown =="
  # `--rmi local` drops the compose-built quack image (disposable, rebuilt next
  # run) but NOT the pulled neo4j:5-community (re-pulling it is slow). Prune the
  # build cache too so repeated runs don't accumulate Docker cruft.
  docker compose down -v --rmi local >/dev/null 2>&1 || true
  docker builder prune -f >/dev/null 2>&1 || true
  rm -rf "$TMPCLIENT"
}
trap cleanup EXIT

CT='content-type: application/json'; AC='accept: application/json, text/event-stream'
call() { # token name args [sub]
  local tok="$1" name="$2" args="$3" sub="${4:-}"
  local extra=(); [ -n "$sub" ] && extra=(-H "x-quack-sub-project: $sub")
  curl -s -m 90 "$URL/mcp" -H "authorization: Bearer $tok" -H "$CT" -H "$AC" "${extra[@]}" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$name\",\"arguments\":$args}}"
}
jtext() { python3 -c 'import sys,json
try:
  d=json.load(sys.stdin); r=d.get("result",{}); c=r.get("content")
  print(c[0]["text"] if c else json.dumps(r))
except Exception: print("")'; }

echo "== bring up Compose stack =="
docker compose up -d --build >/dev/null 2>&1 || { no "docker compose up"; exit 1; }
healthy=0
for i in $(seq 1 40); do
  curl -s -m 4 "$URL/health" 2>/dev/null | grep -q '"graphdb":"ok"' && { healthy=1; break; }
  sleep 3
done
[ "$healthy" = 1 ] && ok "server healthy (/health graphdb ok)" || { no "server health timeout"; exit 1; }
# MCP handshake
call "$ADMIN" __noop__ '{}' >/dev/null 2>&1 || true
curl -s -m 8 "$URL/mcp" -H "authorization: Bearer $ADMIN" -H "$CT" -H "$AC" \
  -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' >/dev/null

echo "== admin plane (bootstrap token) =="
for t in server_status list_users list_projects cleanup_status run_cleanup_now; do
  if call "$ADMIN" "$t" '{}' | grep -q '"isError":true'; then no "admin $t"; else ok "admin $t"; fi
done
SLUG="smoke-$$-$RANDOM"
call "$ADMIN" create_project "{\"slug\":\"$SLUG\",\"display_name\":\"$SLUG\"}" | grep -q '"isError":true' && no "create_project" || ok "create_project $SLUG"
call "$ADMIN" register_user "{\"username\":\"$SLUG\"}" >/dev/null
MTOK=$(call "$ADMIN" add_member "{\"username\":\"$SLUG\",\"project_slug\":\"$SLUG\",\"role\":\"member\"}" | jtext | python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("token",""))
except Exception: print("")')
[ -n "$MTOK" ] && ok "add_member → minted member token" || no "add_member token (cannot continue member tests)"
# .mcp.json the same shape /quack:install writes
cat > "$TMPCLIENT/.mcp.json" <<JSON
{"mcpServers":{"quack":{"type":"http","url":"$URL/mcp","headers":{"Authorization":"Bearer $MTOK","X-Quack-Sub-Project":"$SLUG"}}}}
JSON
ok "client .mcp.json written (shape /quack:install produces)"

if [ -n "$MTOK" ]; then
  # Non-model admin-gate check (always runs, incl. the no-model path): a member
  # token must be 'forbidden' on an admin tool. The comprehensive driver re-checks
  # this (AC-D17E0R.4) when a model is configured.
  echo "== admin gate (member token) =="
  call "$MTOK" list_users '{}' "$SLUG" | grep -q 'forbidden' && ok "admin-gate blocks member token" || no "admin-gate"

  if [ "$MODEL" = 1 ]; then
    echo "== comprehensive full-stack round-trips (bun driver) =="
    # revoke_token (AC-D17E0R.4) needs a numeric token_id, which NO MCP tool
    # exposes — read the member token's row id straight from the container's
    # auth.sqlite and hand it to the driver via env. This keeps the driver's
    # 4-arg signature (AC-D17E0R.1) intact; the driver skips the revoke_token
    # round-trip cleanly when this is empty (e.g. run standalone, off-Docker).
    MEMBER_TOKEN_ID=$(docker compose exec -T quack bun -e 'import {Database} from "bun:sqlite"; const db=new Database("/data/auth.sqlite",{readonly:true}); const r=db.query("SELECT id FROM tokens WHERE revoked_at IS NULL ORDER BY id DESC LIMIT 1").get(); process.stdout.write(r&&r.id!=null?String(r.id):"");' 2>/dev/null)
    QUACK_SMOKE_MEMBER_TOKEN_ID="$MEMBER_TOKEN_ID" bun "$ROOT/scripts/smoke-assertions.ts" "$URL" "$ADMIN" "$MTOK" "$SLUG"
    drv=$?
    [ "$drv" = 0 ] && ok "comprehensive smoke-assertions driver (exit 0)" || no "comprehensive smoke-assertions driver (exit $drv)"
  else
    echo "SKIP: comprehensive round-trips need QUACK_MODEL_* (real-model extraction) — set QUACK_MODEL_API_KEY + QUACK_MODEL_BASE_URL in .env"
  fi
fi

echo ""
echo "==== SMOKE TEST: $PASS passed, $FAIL failed ===="
[ "$FAIL" = 0 ]
