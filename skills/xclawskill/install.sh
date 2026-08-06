#!/usr/bin/env bash
#
# XClawSkill 一键安装脚本
# 自动识别环境并安装到对应技能目录：
#   - Codex      -> ~/.codex/skills/xclawskill   (或 $CODEX_HOME)
#   - Claude Code-> ~/.claude/skills/xclawskill
#   - 通用       -> ~/.xclawskill
# 同时安装 Python 依赖并创建 xclaw-skill 命令。
#
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/qomob/xclawskill/main/install.sh | bash
#   或在仓库内直接运行： bash install.sh
#
set -euo pipefail

REPO_URL="https://github.com/qomob/xclawskill.git"

log() { printf '\033[1;36m[xclawskill]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[xclawskill] 错误: %s\033[0m\n' "$*" >&2; exit 1; }

# ── 1. 定位源码目录（curl|bash 时自动克隆）──────────────────────────────
SCRIPT_PATH="${BASH_SOURCE[0]:-}"
if [ -f "$(dirname "$SCRIPT_PATH")/scripts/xclaw_skill.py" ]; then
  SRC="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
else
  SRC="${XDG_CACHE_HOME:-$HOME/.cache}/xclawskill-src"
  if [ ! -f "$SRC/scripts/xclaw_skill.py" ]; then
    log "克隆源码到 $SRC"
    git clone --depth 1 "$REPO_URL" "$SRC"
  fi
fi

# ── 2. 选择安装目标目录 ─────────────────────────────────────────────────
detect_target() {
  if [ -n "${CODEX_HOME:-}" ] || [ -d "$HOME/.codex" ]; then
    printf '%s' "${CODEX_HOME:-$HOME/.codex}/skills/xclawskill"
  elif [ -d "$HOME/.claude" ]; then
    printf '%s' "$HOME/.claude/skills/xclawskill"
  else
    printf '%s' "$HOME/.xclawskill"
  fi
}

TARGET="$(detect_target)"
mkdir -p "$(dirname "$TARGET")"

# ── 3. 安装技能文件 ─────────────────────────────────────────────────────
log "安装技能到 $TARGET"
rm -rf "$TARGET"
mkdir -p "$TARGET"
cp -R "$SRC/scripts" "$SRC/references" "$TARGET/" 2>/dev/null || true
for f in SKILL.md README.md requirements.txt LICENSE; do
  [ -f "$SRC/$f" ] && cp "$SRC/$f" "$TARGET/"
done

# ── 4. 安装 Python 依赖 ─────────────────────────────────────────────────
log "安装 Python 依赖（cryptography / websocket-client）"
pip_cmds=(
  "python3 -m pip install --user -q -r '$TARGET/requirements.txt'"
  "python3 -m pip install -q -r '$TARGET/requirements.txt'"
  "python3 -m pip install --user --break-system-packages -q -r '$TARGET/requirements.txt'"
  "python3 -m pip install --break-system-packages -q -r '$TARGET/requirements.txt'"
)
deps_ok=""
for cmd in "${pip_cmds[@]}"; do
  if eval "$cmd" 2>/dev/null; then
    deps_ok=1
    break
  fi
done
if [ -z "$deps_ok" ]; then
  log "⚠️ 依赖安装失败——基础功能可用；参与类操作（register 等）需先安装 cryptography 与 websocket-client"
fi

# ── 5. 创建 xclaw-skill 命令 ────────────────────────────────────────────
BIN_DIR="${HOME}/.local/bin"
mkdir -p "$BIN_DIR"
chmod +x "$TARGET/scripts/xclaw_skill.py"
chmod +x "$TARGET/scripts/xclaw-skill"
ln -sfn "$TARGET/scripts/xclaw-skill" "$BIN_DIR/xclaw-skill"

# ── 6. 验证 ─────────────────────────────────────────────────────────────
if [ -x "$BIN_DIR/xclaw-skill" ] && "$BIN_DIR/xclaw-skill" health >/dev/null 2>&1; then
  log "安装完成 ✅（网络自检通过）"
else
  log "安装完成（网络自检跳过，可稍后运行 xclaw-skill verify）"
fi

cat <<EOF

  ✅ XClawSkill 已安装
  技能目录 : $TARGET
  命令     : $BIN_DIR/xclaw-skill

  如果命令找不到，先执行一次：
    export PATH="\$HOME/.local/bin:\$PATH"

  立即体验：
    xclaw-skill health
    xclaw-skill register --agent-name "我的Agent" --capabilities "你的能力描述" --state-file ~/.xclaw/agent.json

EOF
