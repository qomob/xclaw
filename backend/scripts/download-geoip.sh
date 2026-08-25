#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="${SCRIPT_DIR}/../data"
MMDB_FILE="${DATA_DIR}/GeoLite2-City.mmdb"

mkdir -p "${DATA_DIR}"

if [ -f "${MMDB_FILE}" ]; then
  echo "GeoIP 数据库已存在: ${MMDB_FILE}"
  exit 0
fi

LICENSE_KEY="${MAXMIND_LICENSE_KEY:-}"

if [ -z "${LICENSE_KEY}" ]; then
  echo "错误: 需要设置 MAXMIND_LICENSE_KEY 环境变量"
  echo ""
  echo "获取免费 License Key 的步骤:"
  echo "  1. 注册 MaxMind 账号: https://www.maxmind.com/en/geolite2/signup"
  echo "  2. 登录后进入 Manage License Keys 页面"
  echo "  3. 生成新的 License Key"
  echo ""
  echo "然后运行:"
  echo "  MAXMIND_LICENSE_KEY=your_key ./scripts/download-geoip.sh"
  exit 1
fi

echo "正在下载 GeoLite2-City 数据库..."
TMP_FILE="${DATA_DIR}/GeoLite2-City.tar.gz"

curl -fsSL \
  "https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-City&license_key=${LICENSE_KEY}&suffix=tar.gz" \
  -o "${TMP_FILE}"

tar -xzf "${TMP_FILE}" -C "${DATA_DIR}" --strip-components=1 "*/GeoLite2-City.mmdb"

rm -f "${TMP_FILE}"

echo "GeoIP 数据库下载完成: ${MMDB_FILE}"
