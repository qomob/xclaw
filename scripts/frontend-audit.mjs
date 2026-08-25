#!/usr/bin/env node
/**
 * 前端依赖审计（CI 用）
 *
 * 与 `npm audit --audit-level=high` 的差异：
 *   支持显式豁免"已评估接受"的通告（ACCEPTED_ADVISORIES），
 *   其余 high/critical 漏洞仍然导致非零退出（保持 CI 拦截能力）。
 *
 * 当前豁免项（均为 DoS 级、且位于应用不会执行到的代码路径）：
 *   - GHSA-w3rx-r6r6-pgpr  image-size ICNS 解析无限循环
 *   - GHSA-5p2g-fcmc-qvqq  image-size JXL/HEIF 解析无限循环
 *   背景：image-size 由 deck.gl → @loaders.gl/textures → texture-compressor 传递引入，
 *         仅在加载压缩纹理（.ktx/.basis 等 3D 资产）时触达；本应用只用 deck.gl 做地图/
 *         星系可视化，不加载纹理资产。上游尚未发布修复版本（通告范围 `*`），
 *         已通过 overrides 锁定 1.2.1（当前最新 1.x），待上游修复后移除豁免。
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const frontendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../frontend');

const ACCEPTED_ADVISORIES = new Set([
  'GHSA-w3rx-r6r6-pgpr',
  'GHSA-5p2g-fcmc-qvqq',
]);

let raw;
try {
  raw = execFileSync(
    'npm',
    ['audit', '--json', '--registry=https://registry.npmjs.org'],
    { cwd: frontendDir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }
  );
} catch (err) {
  // npm audit 在存在漏洞时以非零码退出，但 stdout 仍带 JSON
  raw = err.stdout;
  if (!raw) {
    console.error('npm audit 执行失败:', err.message);
    process.exit(2);
  }
}

let report;
try {
  report = JSON.parse(raw);
} catch {
  console.error('无法解析 npm audit JSON 输出');
  process.exit(2);
}

const FAIL_LEVELS = new Set(['high', 'critical']);
const findings = [];
const accepted = [];

for (const [pkg, vuln] of Object.entries(report.vulnerabilities || {})) {
  for (const v of vuln.via || []) {
    if (typeof v === 'object' && v.url) {
      const ghsa = (v.url.match(/GHSA-[a-z0-9-]+/i) || [])[0];
      if (FAIL_LEVELS.has(v.severity)) {
        if (ghsa && ACCEPTED_ADVISORIES.has(ghsa)) {
          accepted.push(pkg + ' ' + ghsa);
        } else {
          findings.push('[' + v.severity + '] ' + pkg + ' (' + v.range + ') ' + v.title + ' ' + (ghsa || ''));
        }
      }
    }
  }
}

if (accepted.length) {
  console.log('已豁免（见脚本头部说明）:');
  for (const a of [...new Set(accepted)]) console.log('  - ' + a);
}

if (findings.length) {
  console.error('');
  console.error('存在未豁免的 high/critical 漏洞:');
  for (const f of findings) console.error('  ' + f);
  process.exit(1);
}

console.log('');
console.log('前端依赖审计通过（无未豁免的 high/critical 漏洞）');
