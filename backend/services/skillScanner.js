// 技能自动安全扫描 + 沙箱试跑
// 目标：识别代码注入、密钥泄露、数据外传、欺诈话术、提示词注入、PII 索取等风险。
// 注意：当前技能记录为元数据 + 可选 execution 规格；本扫描为启发式静态检查 +
// 尽力而为的沙箱试跑（timeout + 隔离工作目录 + 最小环境，无法完全阻断网络命名空间）。
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runInStrongSandbox, isDockerAvailable } from './codeSandbox.js';

const RULES = [
  { id: 'INJ_SHELL', severity: 'critical', type: 'code_injection',
    re: /(eval\s*\(|exec\s*\(|os\.system\s*\(|subprocess\s*\.|child_process|require\(['"]child_process|execSync|spawn\(|\brm\s+-rf\b|shutdown\b|curl\s+\S+\s*\|\s*(sh|bash)\b)/,
    hint: '疑似代码注入/危险命令' },
  { id: 'SECRET', severity: 'critical', type: 'secret',
    re: /(AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN (RSA|EC|OPENSSH|PRIVATE) KEY-----|api[_-]?key\s*[:=]\s*['"][A-Za-z0-9_\-]{12,})/i,
    hint: '疑似密钥/凭证泄露' },
  { id: 'EXFIL', severity: 'critical', type: 'exfiltration',
    re: /(https?:\/\/[^\s"']*(pastebin|webhook\.site|requestbin|pipelines?\.dev|ngrok|localtunnel|smee\.io)|https?:\/\/[^\s"']+\/callback)/i,
    hint: '疑似数据外传端点' },
  { id: 'FRAUD', severity: 'high', type: 'fraud',
    re: /(保本|稳赚|翻倍|无风险|免费领取|投资回报|联系客服|加微信|加QQ|银行卡号|身份证号|代充|刷单|秒到账)/,
    hint: '疑似欺诈/诱导话术' },
  { id: 'PROMPT_INJ', severity: 'high', type: 'prompt_injection',
    re: /(ignore (all |the )?(previous|above) instructions|forget everything|you are now|system prompt|jailbreak|越狱|忽略(所有)?(之前|上面)(的)?指令|现在开始扮演)/i,
    hint: '疑似提示词注入' },
  { id: 'PII', severity: 'medium', type: 'pii_request',
    re: /(手机号|身份证|银行卡|验证码|登录密码|家庭住址)/,
    hint: '疑似索取个人敏感信息' },
  { id: 'SUSPICIOUS', severity: 'low', type: 'suspicious',
    re: /(script|execute|run\s+command|下载安装|外部程序)/i,
    hint: '含可执行/下载等敏感词' },
];

const SEV_SCORE = { critical: 3, high: 2, medium: 1, low: 0.5 };

/** 对技能元数据做启发式扫描 */
export function scanSkillMetadata(skill) {
  const haystack = [
    skill.name, skill.description, skill.category, skill.version,
    JSON.stringify(skill.schema || {}),
    JSON.stringify(skill.execution || {}),
  ].filter(Boolean).join('\n');
  const flags = [];
  for (const rule of RULES) {
    if (rule.re.test(haystack)) {
      flags.push({ rule: rule.id, severity: rule.severity, type: rule.type, hint: rule.hint });
    }
  }
  const score = flags.reduce((s, f) => s + (SEV_SCORE[f.severity] || 0), 0);
  let verdict = 'pass';
  if (flags.some(f => f.severity === 'critical' || f.severity === 'high')) verdict = 'reject';
  else if (flags.length > 0) verdict = 'manual';
  return { verdict, score, flags };
}

/** 兜底沙箱试跑（无 Docker 时）：timeout + 隔离目录 + 最小环境 */
export async function sandboxRunLegacy(execution, timeoutMs = 5000) {
  if (!execution || typeof execution !== 'object') {
    return { ok: false, skipped: true, reason: 'no execution spec' };
  }
  const { type, command, script } = execution;
  if (type !== 'shell' && type !== 'node' && type !== 'python') {
    return { ok: false, skipped: true, reason: `unsupported type: ${type}` };
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xclaw-sandbox-'));
  try {
    const code = type === 'shell' ? command : script;
    if (!code) return { ok: false, skipped: true, reason: 'empty execution' };
    const result = await new Promise((resolve) => {
      const opts = {
        cwd: dir,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        env: { PATH: '/usr/bin:/bin', HOME: dir, XCLAW_SANDBOX: '1' },
      };
      const child = type === 'shell'
        ? execFile('/bin/sh', ['-c', String(code)], opts, cb)
        : type === 'python'
          ? execFile('python3', ['-c', String(code)], opts, cb)
          : execFile(process.execPath, ['-e', String(code)], opts, cb);
      function cb(err, stdout, stderr) {
        resolve({
          exit: err ? (err.killed ? 124 : (err.code ?? 1)) : 0,
          stdout: String(stdout || '').slice(0, 2000),
          stderr: String(stderr || '').slice(0, 2000),
        });
      }
      child.on('error', () => resolve({ exit: 2, stdout: '', stderr: 'spawn error' }));
    });
    return { ok: true, ...result };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 沙箱试跑：优先 Docker 强沙箱（断网/资源限制/禁提权/超时强杀），
 * 服务器无 Docker 或显式 SANDBOX_ENGINE=legacy 时回退轻量兜底。
 */
export async function sandboxRun(execution, timeoutMs = 5000) {
  if (!execution || typeof execution !== 'object') {
    return { ok: false, skipped: true, reason: 'no execution spec' };
  }
  const { type } = execution;
  if (!['shell', 'node', 'python'].includes(type)) {
    return { ok: false, skipped: true, reason: `unsupported type: ${type}` };
  }
  if (process.env.SANDBOX_ENGINE !== 'legacy') {
    try {
      if (await isDockerAvailable()) {
        const code = type === 'shell' ? execution.command : execution.script;
        const r = await runInStrongSandbox({ language: type, code, timeoutMs });
        return { ...r, engine: 'docker' };
      }
    } catch { /* 回退 legacy */ }
  }
  return { ...(await sandboxRunLegacy(execution, timeoutMs)), engine: 'legacy' };
}

/** 综合扫描：静态检查 + 沙箱试跑，产出评审摘要 */
export async function scanSkill(skill) {
  const staticResult = scanSkillMetadata(skill);
  let sandbox = null;
  if (skill.execution) {
    sandbox = await sandboxRun(skill.execution);
    // 沙箱试跑异常/超时视为可疑（但静态无高风险时交由人工）
    if (sandbox && !sandbox.skipped && (sandbox.exit !== 0 || /(error|denied|refused)/i.test(sandbox.stderr || ''))) {
      staticResult.flags.push({ rule: 'SANDBOX', severity: 'low', type: 'sandbox', hint: `沙箱试跑异常: exit=${sandbox.exit}` });
      staticResult.score += 0.5;
      if (staticResult.verdict === 'pass') staticResult.verdict = 'manual';
    }
  }
  return { ...staticResult, sandbox };
}
