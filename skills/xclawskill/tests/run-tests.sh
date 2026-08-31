#!/usr/bin/env bash
#
# XClawSkill 冒烟测试：不依赖外部网络，起本地 mock 服务器验证核心动作。
# mock 镜像后端鉴权语义（Bearer JWT / X-API-KEY / 系统Key / Ed25519 注册验签），
# 覆盖 register → 任务市场 → 结算 全链路，并包含鉴权漂移负向回归。
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI="$SCRIPT_DIR/../scripts/xclaw_skill.py"
MOCK="$SCRIPT_DIR/mock_server.py"
PORT="${XCLAWSKILL_TEST_PORT:-18099}"
BASE="http://127.0.0.1:$PORT/api"
STATE="/tmp/xclawskill-state.json"
STATE_STALE="/tmp/xclawskill-state-stale-jwt.json"

python3 -m py_compile "$CLI" "$MOCK" || { echo "FAIL: py_compile"; exit 1; }
echo "OK: py_compile"

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

# 负向断言：期望 HTTP 失败（CLI 退出码非 0）
run_fail() {
  local desc="$1"; shift
  if "$@" >/tmp/xclawskill-test.out 2>&1; then
    echo "FAIL: $desc（预期失败但成功）"; cat /tmp/xclawskill-test.out; exit 1
  else
    echo "OK: $desc"
  fi
}

http_code() {
  curl -s -o /dev/null -w "%{http_code}" "$@"
}

# ── 公开端点 ─────────────────────────────────────────────────────────────
run "health" python3 "$CLI" --base-url "$BASE" --action health
run "discover(table)" python3 "$CLI" --base-url "$BASE" --action discover --query "x" --format table

# ── 注册链路（Ed25519 签名 + x-agent-timestamp 重放防护协议）───────────────
run "register(签名+时间戳)" python3 "$CLI" --base-url "$BASE" --action register \
  --state-file "$STATE" --agent-name "SmokeBot" --capabilities "testing"
run "whoami" python3 "$CLI" --base-url "$BASE" --action whoami --state-file "$STATE"
run "heartbeat" python3 "$CLI" --base-url "$BASE" --action heartbeat --state-file "$STATE"

# ── 任务市场全生命周期（requireAuth：Bearer JWT）─────────────────────────
TASK_ID="3f2504e0-4f89-41d3-9a0c-0305e82c3301"
BID_ID="b7c9e262-5f6e-4a3b-8a1d-2c4e6f8a9b01"
run "create-task(JWT)" python3 "$CLI" --base-url "$BASE" --action create-task \
  --state-file "$STATE" --title "t" --description "d" --budget-min 5 --budget-max 10
run "submit-bid" python3 "$CLI" --base-url "$BASE" --action submit-bid \
  --state-file "$STATE" --task-id "$TASK_ID" --price 8 --proposal "self"
run "accept-bid" python3 "$CLI" --base-url "$BASE" --action accept-bid \
  --state-file "$STATE" --task-id "$TASK_ID" --bid-id "$BID_ID"
run "submit-result" python3 "$CLI" --base-url "$BASE" --action submit-result \
  --state-file "$STATE" --task-id "$TASK_ID" --result '{"output":"done"}'
run "accept-result" python3 "$CLI" --base-url "$BASE" --action accept-result \
  --state-file "$STATE" --task-id "$TASK_ID"
run "cancel-task" python3 "$CLI" --base-url "$BASE" --action cancel-task \
  --state-file "$STATE" --task-id "$TASK_ID"

# ── 观察者 + 鉴权端点（verifyApiKeyOrAgent / requireAuth）────────────────
run "reputation(状态文件)" python3 "$CLI" --base-url "$BASE" --action reputation \
  --state-file "$STATE" --limit 5
run "task-market(状态文件)" python3 "$CLI" --base-url "$BASE" --action task-market \
  --state-file "$STATE"
run "balance(状态文件)" python3 "$CLI" --base-url "$BASE" --action balance \
  --state-file "$STATE"

# ── 技能市场 ─────────────────────────────────────────────────────────────
run "register-skill(JWT)" python3 "$CLI" --base-url "$BASE" --action register-skill \
  --state-file "$STATE" --skill-name "t" --description "d" --category "c"
run "list-skill" python3 "$CLI" --base-url "$BASE" --action list-skill \
  --state-file "$STATE" --skill-id sk-test --price 2.5

# ── 提现 ─────────────────────────────────────────────────────────────────
run "withdraw" python3 "$CLI" --base-url "$BASE" --action withdraw \
  --state-file "$STATE" --to-address "0x1111111111111111111111111111111111111111" --amount 1

# ── 鉴权漂移负向回归（mock 与后端语义一致，客户端协议改动必须同步这些断言）───
CODE=$(http_code -H "Authorization: ak_test" "$BASE/v1/task-market/stats")
[ "$CODE" = "401" ] || { echo "FAIL: 裸 Authorization 携带 Agent Key 应被 401，实际 $CODE"; exit 1; }
echo "OK: 负向-裸 Authorization Agent Key 被拒(401)"

CODE=$(http_code -X POST -H "Authorization: ak_test" -H "Content-Type: application/json" \
  -d '{}' "$BASE/v1/skills/register")
[ "$CODE" = "401" ] || { echo "FAIL: skills/register 裸 Agent Key 应被 401，实际 $CODE"; exit 1; }
echo "OK: 负向-skills/register 裸 Agent Key 被拒(401)"

CODE=$(http_code -H "X-API-KEY: ak_test" "$BASE/v1/task-market/stats")
[ "$CODE" = "200" ] || { echo "FAIL: X-API-KEY 应放行，实际 $CODE"; exit 1; }
echo "OK: 正向-X-API-KEY 放行(200)"

# ── 过期 JWT 自愈：状态文件中的过期 JWT 应被丢弃并用 API Key 重新可用 ───────
python3 - "$STATE_STALE" <<'PYEOF'
import base64, json, sys, time
payload = base64.urlsafe_b64encode(json.dumps(
    {"agent_id": "550e8400-e29b-41d4-a716-446655440000", "exp": int(time.time()) - 10}
).encode()).decode().rstrip("=")
token = f"mock.{payload}.sig"
json.dump({"agent_id": "550e8400-e29b-41d4-a716-446655440000", "api_key": "ak_test",
           "jwt": token, "public_key_pem": "", "private_key_bytes": ""},
          open(sys.argv[1], "w"))
PYEOF
run "reputation(过期JWT自动丢弃)" python3 "$CLI" --base-url "$BASE" --action reputation \
  --state-file "$STATE_STALE" --limit 5

echo "✅ 全部通过"
