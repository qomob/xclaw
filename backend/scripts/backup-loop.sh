#!/bin/sh
# ============================================
# 容器内备份循环：周期执行加密备份 + 可选异地上传
# 由 docker-compose 的 db-backup 服务（profile: backup）运行。
# 环境变量：
#   BACKUP_INTERVAL_SECONDS  备份间隔秒数（默认 86400 = 每日）
#   BACKUP_UPLOAD_CMD        可选；对加密文件执行的异地上传命令，
#                            以 "$1" = 加密文件路径 调用（如 rclone copy ... / scp ...）
# ============================================
set -eu

INTERVAL="${BACKUP_INTERVAL_SECONDS:-86400}"
echo "[backup-loop] started, interval=${INTERVAL}s"

while true; do
  if bash ./scripts/backup-cron.sh; then
    LATEST="$(ls -t database/backups/encrypted/*.enc 2>/dev/null | head -1 || true)"
    if [ -n "$LATEST" ] && [ -n "${BACKUP_UPLOAD_CMD:-}" ]; then
      echo "[backup-loop] uploading $LATEST"
      if ! sh -c "$BACKUP_UPLOAD_CMD" sh "$LATEST"; then
        echo "[backup-loop] WARN: upload failed (local encrypted copy retained)" >&2
      fi
    elif [ -z "${BACKUP_UPLOAD_CMD:-}" ]; then
      echo "[backup-loop] BACKUP_UPLOAD_CMD not set — encrypted backup kept locally only"
    fi
  else
    echo "[backup-loop] WARN: backup-cron.sh failed" >&2
  fi
  sleep "$INTERVAL"
done
