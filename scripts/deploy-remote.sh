#!/usr/bin/env bash
# ============================================
# XClaw 服务器端一键部署脚本（宝塔/阿里云 ECS 通用）
#
# 用法（服务器上）：
#   cd /www/wwwroot
#   git clone https://github.com/qomob/xclaw.git
#   cd xclaw
#   bash scripts/deploy-remote.sh
#
# 或：把脚本放到任意目录，传入项目路径：
#   bash deploy-remote.sh /path/to/xclaw
# ============================================
set -euo pipefail

PROJECT_DIR="${1:-$(pwd)}"
cd "$PROJECT_DIR"

echo "==> XClaw 部署脚本"
echo "    项目目录: $PROJECT_DIR"

# ── 1. 前置检查 ─────────────────────────────
command -v docker >/dev/null 2>&1 || { echo "❌ 未安装 docker，请先在宝塔软件商店安装 Docker 管理器"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "❌ 未安装 docker compose v2"; exit 1; }
echo "✅ docker + compose 已就绪"

# ── 2. 生成/校验 .env ───────────────────────
if [ ! -f .env ]; then
  echo "==> 未发现 .env，正在交互式生成..."
  cp .env.example .env

  read -rp "请输入域名（如 xclaw.example.com）: " DOMAIN
  read -rp "PostgreSQL 密码（回车随机生成）: " PG_PW
  read -rp "Redis 密码（回车随机生成）: " RD_PW
  read -rp "管理员邮箱（仅用于提示）: " ADMIN_EMAIL

  PG_PW="${PG_PW:-$(openssl rand -hex 16)}"
  RD_PW="${RD_PW:-$(openssl rand -hex 16)}"
  JWT=$(openssl rand -hex 32)
  ENC=$(openssl rand -hex 32)
  API=$(openssl rand -hex 24)
  ADMIN=$(openssl rand -hex 24)
  MONITOR=$(openssl rand -hex 16)
  BAK=$(openssl rand -hex 16)

  # 用 Python 精确替换（避免 sed 特殊字符问题）
  python3 - "$DOMAIN" "$PG_PW" "$RD_PW" "$JWT" "$ENC" "$API" "$ADMIN" "$MONITOR" "$BAK" <<'PYEOF'
import re, sys
domain, pg_pw, rd_pw, jwt, enc, api, admin, monitor, bak = sys.argv[1:]
path = '.env'
s = open(path, encoding='utf-8').read()
def rep(key, value):
    global s
    if re.search(rf'^{key}=.*$', s, flags=re.M):
        s = re.sub(rf'^{key}=.*$', f'{key}={value}', s, flags=re.M)
    else:
        s += f'\n{key}={value}'
rep('JWT_SECRET', jwt)
rep('ENCRYPTION_KEY', enc)
rep('API_KEY', 'xclw_' + api)
# 管理密钥必须与 API_KEY 不同：同值等于所有系统 Key 持有者都是 admin
rep('ADMIN_API_KEY', 'xclw_' + admin)
rep('MONITOR_TOKEN', monitor)
rep('POSTGRES_PASSWORD', pg_pw)
rep('REDIS_PASSWORD', rd_pw)
rep('PUBLIC_URL', f'https://{domain}')
rep('WS_PUBLIC_URL', f'wss://{domain}')
rep('FRONTEND_URL', f'https://{domain}')
rep('DOMAIN', domain)
rep('BACKUP_ENCRYPTION_KEY', bak)
open(path, 'w', encoding='utf-8').write(s)
print('  .env 已生成（密钥已随机化）')
PYEOF
else
  echo "✅ 已存在 .env（请自行确认 JWT_SECRET/API_KEY 已填写）"
fi

# ── 3. GeoLite2（可选）──────────────────────
if [ ! -f backend/data/GeoLite2-City.mmdb ]; then
  echo "==> 提示: 未找到 GeoLite2-City.mmdb"
  echo "    如需 IP 定位，请设置 MAXMIND_LICENSE_KEY 后运行:"
  echo "    cd backend && MAXMIND_LICENSE_KEY=xxx ./scripts/download-geoip.sh"
fi

# ── 4. 启动 ─────────────────────────────────
echo "==> docker compose up -d --build"
docker compose up -d --build

# ── 5. 等待健康 ─────────────────────────────
echo "==> 等待服务健康..."
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:8080/api/health" >/dev/null 2>&1; then
    echo "✅ 后端健康检查通过"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "⚠️  30 秒内未通过健康检查，请查看日志: docker compose logs -f backend"
    exit 1
  fi
  sleep 2
done

echo ""
echo "=========================================="
echo " 部署完成 ✅"
echo " 前端:   http://127.0.0.1:8080（请用宝塔 Nginx 反代域名）"
echo " 健康:   https://$(grep '^DOMAIN=' .env | cut -d= -f2)/api/health"
echo " 日志:   docker compose logs -f backend"
echo " 更新:   git pull && docker compose up -d --build"
echo " 备份:   cd backend && BACKUP_ENCRYPTION_KEY=\$(grep '^BACKUP_ENCRYPTION_KEY=' ../.env | cut -d= -f2) ./scripts/backup-cron.sh"
echo "=========================================="
