#!/usr/bin/env bash
#
# XClawSkill 冒烟测试：不依赖外部网络，起本地 mock 服务器验证核心动作
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI="$SCRIPT_DIR/../scripts/xclaw_skill.py"
MOCK="$SCRIPT_DIR/mock_server.py"
PORT="${XCLAWSKILL_TEST_PORT:-18099}"
BASE="http://127.0.0.1:$PORT/api"

python3 "$CLI" --version | grep -qE "^[0-9]+\.[0-9]+\.[0-9]+$" || { echo "FAIL: --version"; exit 1; }
echo "OK: --version"

python3 -c "import http.server" || { echo "SKIP: 需要 python3 内置 http.server"; exit 0; }

python3 "$MOCK" "$PORT" >/tmp/xclawskill-mock.log 2>&1 &
MOCK_PID=$!
trap 'kill $MOCK_PID 2>/dev/null || true' EXIT
sleep 1

run() {
  local desc="$1"; shift
  if "$@" >/tmp/xclawskill-test.out 2>&1; then
    echo "OK: $desc"
  else
    echo "FAIL: $desc"; cat /tmp/xclawskill-test.out; exit 1
  fi
}

run "health" python3 "$CLI" --base-url "$BASE" --action health
run "balance(带Key)" python3 "$CLI" --base-url "$BASE" --action balance --api-key ak_test
printf '{"agent_id":"n1"}' > /tmp/xclawskill-state.json
run "register-skill" python3 "$CLI" --base-url "$BASE" --action register-skill --state-file /tmp/xclawskill-state.json --skill-name "t" --description "d" --category "c"
run "list-skill" python3 "$CLI" --base-url "$BASE" --action list-skill --state-file /tmp/xclawskill-state.json --skill-id sk-test --price 2.5 --api-key ak_test
run "discover(table)" python3 "$CLI" --base-url "$BASE" --action discover --query "x" --format table

echo "✅ 全部通过"
