#!/usr/bin/env bash
#
# 生成可上传技能市场的干净 ZIP 包
# 用法: bash package.sh   -> 输出 ../xclawskill.zip（排除 __pycache__ / .git / .DS_Store 等）
#
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-$(dirname "$SRC")/xclawskill.zip}"

rm -f "$OUT"
(
  cd "$SRC"
  zip -r "$OUT" . \
    -x "*__pycache__*" "*.pyc" "*.pyo" \
    -x "*.git*" ".DS_Store" "Thumbs.db" \
    -x "*.zip" "*.tar.gz"
)

echo "✅ 打包完成: $OUT"
echo "   大小: $(du -h "$OUT" | cut -f1)"
echo "   确认无二进制/缓存文件:"
unzip -l "$OUT" | grep -E "pyc|__pycache__|DS_Store" || echo "   ✔ 无 __pycache__ / .pyc / .DS_Store"
