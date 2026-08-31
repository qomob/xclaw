# XClawSkill 一键安装（Windows PowerShell）
# 用法:  powershell -ExecutionPolicy Bypass -File install.ps1
# 安全策略与 install.sh 对齐：不删除任何数据，旧安装自动备份；非本技能目录需 XCLAWSKILL_FORCE=1
$ErrorActionPreference = "Stop"
$RepoUrl = "https://github.com/qomob/xclawskill.git"

$src = Join-Path $env:TEMP "xclawskill-src"
if (-not (Test-Path (Join-Path $src "scripts\xclaw_skill.py"))) {
  Write-Host "克隆源码..."
  git clone --depth 1 $RepoUrl $src
}

$target = Join-Path $HOME ".xclawskill"
$marker = Join-Path $target ".xclawskill-installed"
if (Test-Path $target) {
  if (-not (Test-Path $marker) -and $env:XCLAWSKILL_FORCE -ne "1") {
    Write-Host "目标目录 $target 已存在但不是 XClawSkill 安装。如确需覆盖请设置 XCLAWSKILL_FORCE=1" -ForegroundColor Red
    exit 1
  }
  $backup = "$target.bak-$(Get-Date -Format 'yyyyMMddHHmmss')"
  Write-Host "检测到旧安装，备份到 $backup（不会删除任何数据）"
  Move-Item $target $backup
}
New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item -Recurse (Join-Path $src "scripts") (Join-Path $src "references") $target
foreach ($f in @("SKILL.md", "README.md", "requirements.txt", "LICENSE")) {
  $p = Join-Path $src $f
  if (Test-Path $p) { Copy-Item $p $target }
}
New-Item -ItemType File -Force -Path $marker | Out-Null

Write-Host "安装 Python 依赖..."
python -m pip install -q -r (Join-Path $target "requirements.txt")

# 创建 xclaw-skill 命令（.cmd 转发器），与 bash 版 ~/.local/bin 位置一致
$binDir = Join-Path $HOME ".local\bin"
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$shim = Join-Path $binDir "xclaw-skill.cmd"
Set-Content -Path $shim -Encoding ASCII -Value @(
  "@echo off",
  "python `"$target\scripts\xclaw_skill.py`" %*"
)

Write-Host ""
Write-Host "✅ XClawSkill 已安装到 $target"
Write-Host "   命令: $shim"
Write-Host ""
Write-Host "使用方式（Windows）:"
Write-Host "  xclaw-skill health"
Write-Host "  xclaw-skill register --agent-name <名> --capabilities <能力> --state-file $HOME\.xclaw\agent.json"
Write-Host ""
Write-Host "如果命令找不到，先执行一次:  \$env:Path += \";$binDir\""
Write-Host "Git Bash / WSL 用户可直接使用: xclaw-skill health"
