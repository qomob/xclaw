#!/usr/bin/env bash
#
# XClaw 自助闭环冒烟脚本（迭代 0/1 验收）
#
# 与 smoke-task-market.sh 的本质区别：全程【不使用 ADMIN_API_KEY】。
# 覆盖：注册(自动发放 sandbox 额度) → 竞标闭环（sandbox 额度托管结算）
#   → 一行调用 /v1/call/:skill_id（上架技能 → 直接下单派单 → 结算）
#
# 通过标准：
#   1) 新注册 Agent 余额 > 0（无管理员充值）
#   2) 竞标闭环：Worker 收到市场价 3 XCL
#   3) 一行调用闭环：Worker 余额增加技能定价 2 XCL
#   4) 全流程无管理员接口调用
#
# 依赖：python3、curl、skills/xclawskill/scripts/xclaw_skill.py
#
# 用法：
#   XCLAW_BASE_URL=http://localhost:8080/api \
#   bash scripts/smoke-self-serve.sh
#
# 环境变量：
#   XCLAW_BASE_URL   API 基地址(默认 https://xclaw.network/api)
#   SMOKE_KEEP_TMP=1 保留临时目录(默认退出即清理)
#   ADMIN_API_KEY    可选。仅用于最后展示 OWTU 指标，不参与任何流程步骤
#
# 常见失败：
#   Caller 余额为 0 → 服务端 SANDBOX_GRANT_ENABLED 未开，
#   或同 IP 24h 内 sandbox 发放已达 SANDBOX_GRANT_IP_DAILY_LIMIT(默认 3 次)。
#   CI/本地反复跑本脚本时，建议服务端临时调高 SANDBOX_GRANT_IP_DAILY_LIMIT。
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
SKILL_CLI="${XCLAWSKILL_CLI:-$REPO_ROOT/skills/xclawskill/scripts/xclaw_skill.py}"

BASE_URL="${XCLAW_BASE_URL:-https://xclaw.network/api}"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/xclaw-smoke-ss.XXXXXX")"
STATUS=0

log()  { printf '\n==> %s\n' "$*"; }
ok()   { printf '    ✔ %s\n' "$*"; }
die()  { printf '    ✘ %s\n' "$*" >&2; STATUS=1; }

jget() {
  python3 - "$1" "$2" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
path = sys.argv[2].split(".")
cur = data
for key in path:
    if isinstance(cur, list):
        cur = cur[int(key)]
    else:
        cur = cur[key]
print(cur)
PY
}

# 浮点比较：num_ge <json-file> <dot.path> <min>
num_ge() {
  python3 - "$1" "$2" "$3" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
cur = data
for key in sys.argv[2].split("."):
    cur = cur[int(key)] if isinstance(cur, list) else cur[key]
print("YES" if float(cur) >= float(sys.argv[3]) - 1e-9 else "NO")
PY
}

# 余额差额断言：balance_delta_eq <file-before> <file-after> <expected-delta>
# （比较两份 balance 接口响应中 data.balance 的增量，容差 1e-6）
balance_delta_eq() {
  python3 - "$1" "$2" "$3" <<'PY'
import json, sys
def bal(path):
    data = json.load(open(path))
    cur = data
    for key in "data.balance".split("."):
        cur = cur[int(key)] if isinstance(cur, list) else cur[key]
    return float(cur)
a, b, want = bal(sys.argv[1]), bal(sys.argv[2]), float(sys.argv[3])
print("YES" if abs((b - a) - want) < 1e-6 else f"NO(delta={b-a}, want={want})")
PY
}

run() {
  local name="$1"; shift
  local oname code
  oname="$(printf '%s' "$name" | tr '/' '_')"
  if "$@" >"$TMP_DIR/$oname.out" 2>&1; then
    ok "$name"
  else
    code=$?
    die "$name exit=$code"
    tail -5 "$TMP_DIR/$oname.out" | sed 's/^/        /' >&2
  fi
}

cli() {
  local state="$1"; shift
  python3 "$SKILL_CLI" --base-url "$BASE_URL" --state-file "$state" "$@"
}

jwt_curl() {
  local state="$1" method="$2" path="$3" body="${4:-}"
  local jwt
  jwt="$(jget "$state" jwt)"
  if [ -n "$body" ]; then
    curl -sS -X "$method" "$BASE_URL$path" \
      -H "Authorization: Bearer $jwt" -H "Content-Type: application/json" -d "$body"
  else
    curl -sS -X "$method" "$BASE_URL$path" -H "Authorization: Bearer $jwt"
  fi
}

step_balance() {
  local state="$1" label="$2"
  jwt_curl "$state" GET "/v1/billing/node/$(jget "$state" agent_id)/balance" \
    > "$TMP_DIR/bal-$label.json"
  printf '        %-16s %s XCL\n' "$label" "$(jget "$TMP_DIR/bal-$label.json" data.balance)"
}

BID_PRICE=3
CALL_PRICE=2

# ── 预检 ──────────────────────────────────────────────────────────────────
log "预检"
[ -f "$SKILL_CLI" ] || { echo "错误: 找不到技能 CLI: $SKILL_CLI" >&2; exit 2; }
run "健康检查 /health" curl -sf -m 10 "$BASE_URL/health" -o "$TMP_DIR/health.json"
[ "$STATUS" -eq 0 ] || { echo "健康检查失败，终止" >&2; exit 1; }
echo "        服务: $(jget "$TMP_DIR/health.json" status) / DB $(jget "$TMP_DIR/health.json" services.database) / Redis $(jget "$TMP_DIR/health.json" services.redis)"

# ── 注册两个 Agent（无管理员参与）──────────────────────────────────────────
STAMP="$(date +%s)"
STATE_CALLER="$TMP_DIR/caller.json"
STATE_WORKER="$TMP_DIR/worker.json"

log "注册 Agent（期望自动发放 sandbox 额度）"
run "注册 Caller(调用方)" cli "$STATE_CALLER" --action register \
  --agent-name "SelfServeCaller-$STAMP" --capabilities "self-serve caller" --tags "smoke"
run "注册 Worker(提供方)" cli "$STATE_WORKER" --action register \
  --agent-name "SelfServeWorker-$STAMP" --capabilities "self-serve worker" --tags "smoke"

CALLER_ID="$(jget "$STATE_CALLER" agent_id)"
WORKER_ID="$(jget "$STATE_WORKER" agent_id)"
echo "        Caller: $CALLER_ID"
echo "        Worker: $WORKER_ID"

# Worker 基线余额（Worker 同样可能获得 sandbox 额度，增量断言以此为基线）
step_balance "$STATE_WORKER" "worker-initial"

log "断言 1：Caller 余额 > 0（零充值、零管理员参与）"
step_balance "$STATE_CALLER" "caller-initial"
if [ "$(num_ge "$TMP_DIR/bal-caller-initial.json" data.balance 0.01)" = "YES" ]; then
  ok "sandbox 额度已自动发放（$(jget "$TMP_DIR/bal-caller-initial.json" data.balance) XCL）"
else
  die "Caller 余额为 0 —— 检查服务端 SANDBOX_GRANT_ENABLED 是否开启 / 同 IP 24h 发放次数是否已达上限"
fi

# ── 竞标闭环（sandbox 额度作托管）──────────────────────────────────────────
log "竞标闭环（预算 2-3 XCL，全部由 sandbox 额度托管）"
run "创建市场任务" cli "$STATE_CALLER" --action create-task \
  --title "SelfServe $STAMP" --description "no-admin smoke loop" \
  --budget-min 2 --budget-max "$BID_PRICE" --assignment-strategy bid
TASK_ID="$(jget "$TMP_DIR/创建市场任务.out" data.task_id)"
echo "        Task: $TASK_ID"
[ -n "$TASK_ID" ] || { die "未拿到 task_id"; }

run "Worker 竞标 $BID_PRICE XCL" cli "$STATE_WORKER" --action submit-bid \
  --task-id "$TASK_ID" --price "$BID_PRICE" --proposal "self-serve smoke bid"
BID_ID="$(jget "$TMP_DIR/Worker 竞标 $BID_PRICE XCL.out" data.bid_id)"

run "Caller 接受竞标" cli "$STATE_CALLER" --action accept-bid \
  --task-id "$TASK_ID" --bid-id "$BID_ID"
run "Worker 提交结果" cli "$STATE_WORKER" --action submit-result \
  --task-id "$TASK_ID" --result "{\"output\":\"self-serve ok\"}"
run "Caller 验收放款" cli "$STATE_CALLER" --action accept-result --task-id "$TASK_ID"

step_balance "$STATE_WORKER" "worker-after-bid"
log "断言 2：Worker 余额增量 = $BID_PRICE XCL"
if [ "$(balance_delta_eq "$TMP_DIR/bal-worker-initial.json" "$TMP_DIR/bal-worker-after-bid.json" "$BID_PRICE")" = "YES" ]; then
  ok "竞标闭环自助结算成功"
else
  die "Worker 余额增量 ≠ $BID_PRICE"
fi

# ── 一行调用闭环（/v1/call/:skill_id）─────────────────────────────────────
log "一行调用闭环"
run "Worker 注册技能" cli "$STATE_WORKER" --action register-skill \
  --skill-name "selfserve-echo-$STAMP" --description "echo input for smoke" \
  --category "utility"
SKILL_ID="$(jget "$TMP_DIR/Worker 注册技能.out" data.skill_id)"
echo "        Skill: $SKILL_ID"

run "Worker 上架(定价 $CALL_PRICE)" cli "$STATE_WORKER" --action list-skill \
  --skill-id "$SKILL_ID" --price "$CALL_PRICE"

curl -sS -X POST "$BASE_URL/v1/call/$SKILL_ID" \
  -H "Authorization: Bearer $(jget "$STATE_CALLER" jwt)" \
  -H "Content-Type: application/json" \
  -d '{"input":{"msg":"hello one-line call"}}' > "$TMP_DIR/call.json"
run "解析调用响应" python3 -c "import json,sys; d=json.load(open(sys.argv[1])); assert d.get('success'), d; print(d['data']['task_id'])" "$TMP_DIR/call.json"
CALL_TASK_ID="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['data']['task_id'])" "$TMP_DIR/call.json")"
echo "        Call Task: ${CALL_TASK_ID} (提供方 ${WORKER_ID} 已被直接派单)"

run "Worker 提交调用结果" cli "$STATE_WORKER" --action submit-result \
  --task-id "$CALL_TASK_ID" --result "{\"output\":\"echo: hello one-line call\"}"
run "Caller 验收调用结果" cli "$STATE_CALLER" --action accept-result --task-id "$CALL_TASK_ID"

step_balance "$STATE_WORKER" "worker-final"
step_balance "$STATE_CALLER" "caller-final"
log "断言 3：Worker 余额增量 = $CALL_PRICE XCL（技能定价）"
if [ "$(balance_delta_eq "$TMP_DIR/bal-worker-after-bid.json" "$TMP_DIR/bal-worker-final.json" "$CALL_PRICE")" = "YES" ]; then
  ok "一行调用闭环自助结算成功"
else
  die "Worker 余额增量 ≠ $CALL_PRICE"
fi

# ── 可选：展示北极星指标（不参与判定）───────────────────────────────────────
if [ -n "${ADMIN_API_KEY:-}" ]; then
  log "（展示）OWTU 指标 — 本机自然成交已计入，敬请观察"
  curl -sS "$BASE_URL/v1/admin/analytics/growth" \
    -H "Authorization: $ADMIN_API_KEY" > "$TMP_DIR/growth.json" 2>/dev/null \
    && python3 -c "
import json
try:
    d = json.load(open('$TMP_DIR/growth.json'))['data']
    print('        OWTU 本周:', d['owtu']['current_week'], '| 上周:', d['owtu']['prev_week'])
except Exception:
    print('        指标获取失败（不影响冒烟结果）')
" || true
fi

# ── 汇总 ──────────────────────────────────────────────────────────────────
log "结果"
if [ "$STATUS" -eq 0 ]; then
  echo "    ✔ 自助闭环全部通过：注册 → sandbox 额度 → 竞标结算 → 一行调用结算（全程无管理员）"
else
  echo "    ✘ 存在失败步骤，见上方输出" >&2
fi

if [ "${SMOKE_KEEP_TMP:-0}" != "1" ]; then
  rm -rf "$TMP_DIR"
else
  echo "        临时目录保留: $TMP_DIR"
fi
exit "$STATUS"
