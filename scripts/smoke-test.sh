#!/usr/bin/env bash
# Full-stack smoke test for Quack — brings up the real Compose stack (server +
# Neo4j) reading .env, then exercises every MCP tool, the admin gate, the
# add_memory→extraction→search pipeline, ask_memory (when QUACK_MODEL_* is set),
# and a real hook → /ingest round-trip. Tears the stack down on exit.
#
#   bash scripts/smoke-test.sh
#
# Skips cleanly (exit 0) when Docker is unreachable. Exits non-zero on any
# assertion failure. Spends a small amount of cheap-model tokens when a model is
# configured (extraction + ask_memory).
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
  echo "== memory plane (member token) + admin gate =="
  call "$MTOK" search_memory '{"entities":["nothing-here"]}' "$SLUG" | jtext | grep -q 'no_full_text_match' && ok "search_memory empty envelope" || no "search_memory"
  call "$MTOK" get_neighbors '{"node_id":"missing"}' "$SLUG" | jtext | grep -q '"results"' && ok "get_neighbors" || no "get_neighbors"
  call "$MTOK" path_between '{"node_a":"a","node_b":"b"}' "$SLUG" | jtext | grep -q 'no_path_found' && ok "path_between" || no "path_between"
  call "$MTOK" recent_decisions '{"time_window":"7d"}' "$SLUG" | jtext | grep -q '"results"' && ok "recent_decisions" || no "recent_decisions"
  call "$MTOK" list_users '{}' "$SLUG" | grep -q 'forbidden' && ok "admin-gate blocks member token" || no "admin-gate"

  echo "== add_memory → extraction =="
  call "$MTOK" add_memory '{"content":"We chose PostgreSQL for the billing service because of its strong transactional guarantees. Bob owns the billing module."}' "$SLUG" | jtext | grep -q '"accepted":true' && ok "add_memory accepted" || no "add_memory"
  if [ "$MODEL" = 1 ]; then
    found=0
    for i in $(seq 1 20); do
      call "$MTOK" search_memory '{"entities":["PostgreSQL","billing","Bob"]}' "$SLUG" | jtext | grep -qiE 'postgres|billing|bob' && { found=1; break; }
      sleep 3
    done
    [ "$found" = 1 ] && ok "extraction populated graph via real model" || no "extraction: nothing surfaced in 60s"

    echo "== ask_memory (real model, agentic) =="
    ANS=$(call "$MTOK" ask_memory '{"question":"Which database does the billing service use and why, and who owns it?"}' "$SLUG" | jtext)
    if echo "$ANS" | grep -q '"mode_used":"planned"' && echo "$ANS" | grep -qiE 'postgres'; then
      ok "ask_memory returned a grounded, <memory>-wrapped answer"
    else
      no "ask_memory: ${ANS:0:160}"
    fi
  else
    echo "== ask_memory (no model configured) =="
    call "$MTOK" ask_memory '{"question":"anything?"}' "$SLUG" | grep -q 'model_unavailable' && ok "ask_memory → model_unavailable gate" || no "ask_memory gate"
  fi

  echo "== hooks → /ingest round-trip =="
  before=$(call "$ADMIN" server_status '{}' | jtext | python3 -c 'import sys,json
try: print(json.load(sys.stdin)["queue"]["accepted_total"])
except Exception: print(-1)')
  echo '{"session_id":"smoke","cwd":"'"$TMPCLIENT"'","tool_name":"Bash","tool_input":{"command":"echo hi"},"tool_response":{"stdout":"the billing service uses PostgreSQL"}}' \
    | ( cd "$TMPCLIENT" && bun "$ROOT/plugins/quack/hooks/_lib/entry/post_tool_use.ts" ) >/dev/null 2>&1
  after="$before"
  for i in $(seq 1 10); do
    after=$(call "$ADMIN" server_status '{}' | jtext | python3 -c 'import sys,json
try: print(json.load(sys.stdin)["queue"]["accepted_total"])
except Exception: print(-1)')
    [ "$after" -gt "$before" ] && break
    sleep 2
  done
  [ "$after" -gt "$before" ] && ok "post_tool_use hook POSTed to /ingest (accepted_total $before→$after)" || no "hook ingest (accepted_total $before→$after)"
fi

echo ""
echo "==== SMOKE TEST: $PASS passed, $FAIL failed ===="
[ "$FAIL" = 0 ]
