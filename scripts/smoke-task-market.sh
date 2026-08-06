#!/usr/bin/env bash
#
# XClaw 任务市场闭环自动化冒烟脚本
#
# 覆盖完整链路：注册 Agent → 管理员充值 → 创建市场任务（托管预算）
#   → 竞标 → 接受竞标（派活）→ 提交结果 → 验收放款（positive）或
#   拒绝进入争议 → 管理员仲裁退款（dispute）
#
# 依赖：
#   - python3（解析 JSON，服务器已具备）
#   - curl
#   - 本仓库 skills/xclawskill/scripts/xclaw_skill.py（XClawSkill CLI）
#
# 用法：
#   XCLAW_BASE_URL=https://xclaw.network/api \
#   ADMIN_API_KEY=ak_xxx \
#   bash scripts/smoke-task-market.sh [both|dispute|positive]
#
# 环境变量：
#   XCLAW_BASE_URL    API 基地址（默认 https://xclaw.network/api）
#   ADMIN_API_KEY     管理员 Key（必填，用于充值/派发/仲裁）
#   TOPUP_AMOUNT      充值额度（默认 100 XCL）
#   SMOKE_KEEP_TMP=1  保留临时目录（默认退出即清理）
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
SKILL_CLI="${XCLAWSKILL_CLI:-$REPO_ROOT/skills/xclawskill/scripts/xclaw_skill.py}"

BASE_URL="${XCLAW_BASE_URL:-https://xclaw.network/api}"
ADMIN_KEY="${ADMIN_API_KEY:-}"
MODE="${1:-both}"
TOPUP_AMOUNT="${TOPUP_AMOUNT:-100}"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/xclaw-smoke.XXXXXX")"
STATUS=0

log()  { printf '\n==> %s\n' "$*"; }
ok()   { printf '    ✔ %s\n' "$*"; }
die()  { printf '    ✘ %s\n' "$*" >&2; STATUS=1; }

# 从 JSON 文件取嵌套字段：jget <file> <dot.path>
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

# 运行一步并记录结果：run <name> <cmd...>
run() {
  local name="$1"; shift
  if "$@" >"$TMP_DIR/$name.out" 2>&1; then
    ok "$name"
  else
    die "$name（exit $?）"
    tail -5 "$TMP_DIR/$name.out" | sed 's/^/        /' >&2
  fi
}

# 调用技能 CLI（携带某个 Agent 的状态文件）：cli <state-file> --action ...
cli() {
  local state="$1"; shift
  python3 "$SKILL_CLI" --base-url "$BASE_URL" --state-file "$state" "$@"
}

# 用 Agent JWT 调接口：jwt_curl <state-file> <method> <path> [body]
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

# 管理员接口
admin_curl() {
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" "$BASE_URL$path" \
      -H "Authorization: $ADMIN_KEY" -H "Content-Type: application/json" -d "$body"
  else
    curl -sS -X "$method" "$BASE_URL$path" -H "Authorization: $ADMIN_KEY"
  fi
}

step_balance() {
  local state="$1" label="$2"
  jwt_curl "$state" GET "/v1/billing/node/$(jget "$state" agent_id)/balance" \
    > "$TMP_DIR/bal-$label.json"
  printf '        %-12s %s XCL\n' "$label" "$(jget "$TMP_DIR/bal-$label.json" data.balance)"
}

# ── 预检 ──────────────────────────────────────────────────────────────────
log "预检"
[ -n "$ADMIN_KEY" ] || { echo "错误: 请设置 ADMIN_API_KEY 环境变量" >&2; exit 2; }
[ -x "$SKILL_CLI" ] || { echo "错误: 找不到技能 CLI: $SKILL_CLI" >&2; exit 2; }
run "健康检查 /health" curl -sf -m 10 "$BASE_URL/health" -o "$TMP_DIR/health.json"
[ "$STATUS" -eq 0 ] || { echo "健康检查失败，终止" >&2; exit 1; }
echo "        服务: $(jget "$TMP_DIR/health.json" status) / DB $(jget "$TMP_DIR/health.json" services.database) / Redis $(jget "$TMP_DIR/health.json" services.redis)"

# ── 注册两个测试 Agent ─────────────────────────────────────────────────────
STAMP="$(date +%s)"
STATE_CALLER="$TMP_DIR/caller.json"
STATE_WORKER="$TMP_DIR/worker.json"

log "注册 Agent"
run "注册 Caller（发布方）" cli "$STATE_CALLER" --action register \
  --agent-name "SmokeCaller-$STAMP" --capabilities "smoke caller" --tags "smoke"
run "注册 Worker（执行方）" cli "$STATE_WORKER" --action register \
  --agent-name "SmokeWorker-$STAMP" --capabilities "smoke worker" --tags "smoke"

CALLER_ID="$(jget "$STATE_CALLER" agent_id)"
WORKER_ID="$(jget "$STATE_WORKER" agent_id)"
echo "        Caller: $CALLER_ID"
echo "        Worker: $WORKER_ID"

# ── 管理员充值 ─────────────────────────────────────────────────────────────
log "管理员为 Caller 充值 $TOPUP_AMOUNT XCL"
run "topup" admin_curl POST "/v1/billing/topup" "{\"node_id\":\"$CALLER_ID\",\"amount\":$TOPUP_AMOUNT}"
step_balance "$STATE_CALLER" "Caller 余额"

# ── 运行指定模式的闭环 ─────────────────────────────────────────────────────
run_loop() {
  local mode="$1"
  local task_id bid_id

  log "[$mode] 创建市场任务（策略 bid，预算 30-40 XCL）"
  run "[$mode] create-task" cli "$STATE_CALLER" --action create-task \
    --title "Smoke $mode $STAMP" --description "automated smoke test ($mode)" \
    --budget-min 30 --budget-max 40 --assignment-strategy bid
  task_id="$(jget "$TMP_DIR/[$mode] create-task.out" data.task_id)"
  echo "        Task: $task_id"
  [ -n "$task_id" ] || { die "[$mode] 未拿到 task_id"; return; }
  step_balance "$STATE_CALLER" "Caller(托管后)"

  log "[$mode] Worker 竞标 35 XCL"
  run "[$mode] submit-bid" cli "$STATE_WORKER" --action submit-bid \
    --task-id "$task_id" --price 35 --proposal "smoke bid $mode"
  bid_id="$(jget "$TMP_DIR/[$mode] submit-bid.out" data.bid_id)"
  echo "        Bid: $bid_id"
  [ -n "$bid_id" ] || { die "[$mode] 未拿到 bid_id"; return; }

  log "[$mode] Caller 接受竞标（派活）"
  run "[$mode] accept-bid" cli "$STATE_CALLER" --action accept-bid \
    --task-id "$task_id" --bid-id "$bid_id"

  log "[$mode] Worker 提交结果"
  run "[$mode] submit-result" cli "$STATE_WORKER" --action submit-result \
    --task-id "$task_id" --result "{\"output\":\"smoke $mode ok\"}"

  local final_status
  if [ "$mode" = "positive" ]; then
    log "[$mode] Caller 验收放款"
    run "[$mode] accept-result" cli "$STATE_CALLER" --action accept-result --task-id "$task_id"
    final_status="completed"
    step_balance "$STATE_WORKER" "Worker 余额"
  else
    log "[$mode] Caller 拒绝结果 → 争议"
    run "[$mode] reject-result" cli "$STATE_CALLER" --action reject-result \
      --task-id "$task_id" --reason "smoke reject $mode"

    log "[$mode] 管理员列出争议并仲裁（退款给调用方）"
    run "[$mode] disputes-list" admin_curl GET "/v1/admin/task-market/disputes?status=open&limit=50"
    local dispute_id
    dispute_id="$(python3 - "$TMP_DIR/[$mode] disputes-list.out" "$task_id" <<'PY'
import json, sys
data = json.load(open(sys.argv[1])).get("data", [])
match = [d for d in data if d.get("task_id") == sys.argv[2]]
print(match[0]["id"] if match else "")
PY
)"
    if [ -z "$dispute_id" ]; then
      die "[$mode] 未找到 task 的争议记录"
      return
    fi
    echo "        Dispute: $dispute_id"
    run "[$mode] disputes-resolve" admin_curl POST \
      "/v1/admin/task-market/disputes/$dispute_id/resolve" '{"resolution":"refunded_caller"}'
    final_status="cancelled"
    step_balance "$STATE_CALLER" "Caller(退款后)"
  fi

  log "[$mode] 校验最终状态（应 $final_status）"
  local actual
  actual="$(admin_curl GET "/v1/task-market/tasks/$task_id" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["status"])')"
  if [ "$actual" = "$final_status" ]; then
    ok "[$mode] 任务状态 = $actual"
  else
    die "[$mode] 任务状态 = $actual（期望 $final_status）"
  fi
}

case "$MODE" in
  both)
    run_loop dispute
    run_loop positive
    ;;
  dispute|positive)
    run_loop "$MODE"
    ;;
  *)
    echo "用法: $0 [both|dispute|positive]" >&2
    exit 2
    ;;
esac

# ── 汇总 ───────────────────────────────────────────────────────────────────
if [ "$STATUS" -eq 0 ]; then
  echo
  log "✅ 冒烟通过：任务市场闭环（$MODE）全部步骤成功"
else
  echo
  log "❌ 冒烟失败：存在失败步骤，详情见上方输出；临时文件保留在 $TMP_DIR"
  SMOKE_KEEP_TMP=1
fi

if [ "${SMOKE_KEEP_TMP:-0}" != "1" ]; then
  rm -rf "$TMP_DIR"
fi

exit "$STATUS"
