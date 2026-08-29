#!/usr/bin/env bash
set -euo pipefail

# ============================================
# 加密数据库备份（供 cron 每日执行）
#
# crontab 示例（每 02:00 执行）:
#   0 2 * * * cd /path/to/XClaw/backend && ./scripts/backup-cron.sh >> /var/log/xclaw-backup.log 2>&1
#
# 需要环境变量 BACKUP_ENCRYPTION_KEY（32 字节 hex，与后端 .env 一致）:
#   export BACKUP_ENCRYPTION_KEY=$(openssl rand -hex 32)
# ============================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
BACKUP_DIR="${PROJECT_ROOT}/database/backups"
ENC_DIR="${BACKUP_DIR}/encrypted"

if [ -z "${BACKUP_ENCRYPTION_KEY:-}" ]; then
  echo "错误: BACKUP_ENCRYPTION_KEY 未设置" >&2
  exit 1
fi

mkdir -p "${BACKUP_DIR}" "${ENC_DIR}"

echo "[backup] 开始备份 $(date '+%Y-%m-%d %H:%M:%S')"

node "${SCRIPT_DIR}/backupDatabase.js"

LATEST="$(ls -t "${BACKUP_DIR}"/*.sql 2>/dev/null | head -1)"
if [ -z "${LATEST}" ]; then
  echo "错误: 未找到备份文件" >&2
  exit 1
fi

OUT="${ENC_DIR}/$(basename "${LATEST%.sql}").sql.enc"
openssl enc -aes-256-cbc -pbkdf2 -salt -pass "env:BACKUP_ENCRYPTION_KEY" \
  -in "${LATEST}" -out "${OUT}"

# 清理明文与 7 天前的加密备份
rm -f "${LATEST}"
find "${ENC_DIR}" -name '*.enc' -mtime +7 -delete

echo "[backup] 完成: ${OUT} ($(du -h "${OUT}" | cut -f1))"
