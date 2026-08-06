# XClawSkill 一键安装（Windows PowerShell）
# 用法:  powershell -ExecutionPolicy Bypass -File install.ps1
$ErrorActionPreference = "Stop"
$RepoUrl = "https://github.com/qomob/xclawskill.git"

$src = Join-Path $env:TEMP "xclawskill-src"
if (-not (Test-Path (Join-Path $src "scripts\xclaw_skill.py"))) {
  Write-Host "克隆源码..."
  git clone --depth 1 $RepoUrl $src
}

$target = Join-Path $HOME ".xclawskill"
if (Test-Path $target) { Remove-Item -Recurse -Force $target }
New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item -Recurse (Join-Path $src "scripts") (Join-Path $src "references") $target
foreach ($f in @("SKILL.md", "README.md", "requirements.txt", "LICENSE")) {
  $p = Join-Path $src $f
  if (Test-Path $p) { Copy-Item $p $target }
}

Write-Host "安装 Python 依赖..."
python -m pip install -q -r (Join-Path $target "requirements.txt")

Write-Host ""
Write-Host "✅ XClawSkill 已安装到 $target"
Write-Host ""
Write-Host "使用方式（Windows）:"
Write-Host "  python $target\scripts\xclaw_skill.py health"
Write-Host "  python $target\scripts\xclaw_skill.py register --agent-name <名> --capabilities <能力> --state-file $HOME\.xclaw_agent_state.json"
Write-Host ""
Write-Host "Git Bash / WSL 用户可直接使用: xclaw-skill health"
