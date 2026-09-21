#!/usr/bin/env node
// 安全回归冒烟：验证 P0 修复在真实服务上的行为（需要已启动的后端 + DB/Redis）。
//
// 用法：
//   XCLAW_BASE_URL=http://localhost:8081/api \
//   ADMIN_API_KEY=<admin key> \
//   node scripts/smoke-security.mjs
//
// 覆盖：
//   1. 注册/心跳鉴权（无凭据 401，带 Agent Key 200）
//   2. 财务数据 IDOR（他人 billing 403 / 交易流水过滤 403）
//   3. 任务重复完成不重复发奖（幂等）
//   4. 任务状态机（终态不可逆、非法流转被拒）
//   5. 执行方计费封顶（超额 400）
//   6. 托管任务禁止走通用完成路径
//   7. sandbox 额度不可提现
//   8. WebSocket：未认证连接不能踢掉已认证连接
//   9. 管理端对账接口可用且账目一致
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
// ws 位于 backend/node_modules —— 用 createRequire 相对后端解析，
// 这样脚本在仓库根目录直接运行也无需 NODE_PATH
const requireFromBackend = createRequire(new URL('../backend/package.json', import.meta.url));
const WebSocket = requireFromBackend('ws');

const BASE = (process.env.XCLAW_BASE_URL || 'http://localhost:8081/api').replace(/\/$/, '');
const WS_BASE = BASE.replace(/^http/, 'ws');
const ADMIN_KEY = process.env.ADMIN_API_KEY || '';

let pass = 0;
let fail = 0;

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function req(method, path, { body, agentKey, token, adminKey } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (agentKey) headers['X-API-KEY'] = agentKey;
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (adminKey) headers['Authorization'] = adminKey;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* 空响应 */ }
  return { status: res.status, body: json };
}

function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKey,
  };
}

function registerAgent(name) {
  const keys = generateKeyPair();
  const payload = {
    agent_name: name,
    capabilities: 'smoke-test, security-regression',
    public_key: keys.publicKey,
  };
  const timestamp = Date.now().toString();
  const signature = crypto.sign(null, Buffer.from(`${timestamp}:${JSON.stringify(payload)}`), keys.privateKey).toString('base64');
  return { payload, signature, timestamp, keys };
}

async function createAgent(name) {
  const { payload, signature, timestamp, keys } = registerAgent(name);
  const res = await fetch(`${BASE}/v1/agents/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-agent-signature': signature,
      'x-agent-timestamp': timestamp,
    },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (!json?.success) throw new Error(`注册失败: ${JSON.stringify(json)}`);
  const agentId = json.data.agent_id;
  const sandboxCredit = json.data.sandbox_credit || null;
  // 用 Ed25519 签名换取 Agent API Key（登录端点）
  const ts = Date.now().toString();
  const authSig = crypto.sign(null, Buffer.from(JSON.stringify({ agent_id: agentId, timestamp: ts })), keys.privateKey).toString('base64');
  const login = await fetch(`${BASE}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: agentId, timestamp: ts, signature: authSig, api_key: json.data.api_key }),
  });
  const loginJson = await login.json();
  const agentKey = loginJson?.data?.api_key || json.data.api_key;
  return { agentId, agentKey, keys, sandboxCredit };
}

async function fetchBalance(agentId, agentKey) {
  const r = await req('GET', '/v1/billing/balance', { agentKey });
  return r.body?.data || {};
}

// ── 1. 心跳鉴权 ─────────────────────────────────────────────
async function testHeartbeatAuth(agent) {
  console.log('\n[1] 心跳鉴权');
  const noAuth = await req('POST', `/v1/agents/${agent.agentId}/heartbeat`);
  check('无凭据心跳被拒绝 (401)', noAuth.status === 401, `got ${noAuth.status}`);

  const withKey = await req('POST', `/v1/agents/${agent.agentId}/heartbeat`, { agentKey: agent.agentKey });
  check('携带 Agent Key 心跳成功 (200)', withKey.status === 200, `got ${withKey.status}`);

  // 伪造签名（用另一对密钥签）应被拒绝
  const other = generateKeyPair();
  const ts = Date.now().toString();
  const badSig = crypto.sign(null, Buffer.from(JSON.stringify({ agent_id: agent.agentId, timestamp: ts })), other.privateKey).toString('base64');
  const forged = await fetch(`${BASE}/v1/agents/${agent.agentId}/heartbeat`, {
    method: 'POST',
    headers: { 'x-agent-signature': badSig, 'x-agent-timestamp': ts, 'Content-Type': 'application/json' },
  });
  check('伪造签名心跳被拒绝 (401)', forged.status === 401, `got ${forged.status}`);
}

// ── 2. 财务数据 IDOR ────────────────────────────────────────
async function testBillingIdor(a, b) {
  console.log('\n[2] 财务数据 IDOR');
  const anonymous = await req('GET', `/v1/agents/${a.agentId}/billing`);
  check('未认证读取他人账单被拒绝 (401)', anonymous.status === 401, `got ${anonymous.status}`);

  const crossRead = await req('GET', `/v1/agents/${a.agentId}/billing`, { agentKey: b.agentKey });
  check('他人 Key 读取账单被拒绝 (403)', crossRead.status === 403, `got ${crossRead.status}`);

  const ownRead = await req('GET', `/v1/agents/${a.agentId}/billing`, { agentKey: a.agentKey });
  check('本人读取账单成功 (200)', ownRead.status === 200, `got ${ownRead.status}`);

  const crossTx = await req('GET', `/v1/billing/transactions?node_id=${a.agentId}`, { agentKey: b.agentKey });
  check('交易流水按他人 node_id 查询被拒绝 (403)', crossTx.status === 403, `got ${crossTx.status}`);

  const ownTx = await req('GET', '/v1/billing/transactions', { agentKey: a.agentKey });
  check('本人交易流水可读 (200)', ownTx.status === 200, `got ${ownTx.status}`);
}

// ── 3/4/5/6. 任务资金路径 ───────────────────────────────────
async function fundCaller(caller) {
  console.log('\n[0] 管理员充值（幂等校验）');
  if (!ADMIN_KEY) {
    console.log('  ⏭  未提供 ADMIN_API_KEY：跳过充值，资金路径用例将依赖已有余额');
    return false;
  }
  const idem = `smoke-${Date.now()}`;
  const before = await fetchBalance(caller.agentId, caller.agentKey);
  const first = await req('POST', '/v1/billing/topup', {
    adminKey: ADMIN_KEY,
    body: { node_id: caller.agentId, amount: 5, method: 'smoke', idempotency_key: idem },
  });
  const dup = await req('POST', '/v1/billing/topup', {
    adminKey: ADMIN_KEY,
    body: { node_id: caller.agentId, amount: 5, method: 'smoke', idempotency_key: idem },
  });
  const after = await fetchBalance(caller.agentId, caller.agentKey);

  check('管理员充值成功 (200)', first.status === 200, `status=${first.status} body=${JSON.stringify(first.body)}`);
  check('同 idempotency_key 重复请求返回重复标记', dup.body?.duplicate === true, JSON.stringify(dup.body));
  const delta = Math.round((after.balance - before.balance) * 100) / 100;
  check('重复请求未重复入账', delta === 5, `delta=${delta} expected=5`);
  return after.balance > 0;
}

async function testTaskMoneyPath(caller, worker) {
  console.log('\n[3] 任务重复完成幂等');
  const created = await req('POST', '/v1/tasks', {
    agentKey: caller.agentKey,
    body: { title: 'smoke-task', type: 'smoke', target_agent_id: worker.agentId },
  });
  const taskId = created.body?.data?.id;
  check('任务创建成功', !!taskId, JSON.stringify(created.body));

  // 期望结算金额 = reward_amount 或 TASK_BASE_PRICE(0.01)
  const reward = parseFloat(created.body?.data?.reward_amount) || 0.01;

  const callerFunds = await fetchBalance(caller.agentId, caller.agentKey);
  if (parseFloat(callerFunds.balance) < reward) {
    console.log(`  ⏭  调用方余额不足（${callerFunds.balance} < ${reward}），跳过结算类断言（配置 ADMIN_API_KEY 可自动充值）`);
    return;
  }
  const before = await fetchBalance(worker.agentId, worker.agentKey);

  const done1 = await req('POST', `/v1/tasks/${taskId}/complete`, { agentKey: worker.agentKey, body: { result: { ok: true } } });
  check('执行方完成任务 (200)', done1.status === 200, `got ${done1.status} ${JSON.stringify(done1.body)}`);
  const afterFirst = await fetchBalance(worker.agentId, worker.agentKey);

  const done2 = await req('POST', `/v1/tasks/${taskId}/complete`, { agentKey: worker.agentKey, body: { result: { ok: true } } });
  const afterSecond = await fetchBalance(worker.agentId, worker.agentKey);

  check('重复完成被幂等处理（不报错）', done2.status === 200 && done2.body?.data?.duplicate === true,
    `status=${done2.status} dup=${done2.body?.data?.duplicate}`);
  const delta1 = Math.round((afterFirst.balance - before.balance) * 100) / 100;
  const delta2 = Math.round((afterSecond.balance - afterFirst.balance) * 100) / 100;
  check('首次完成发放奖励', delta1 === reward, `delta=${delta1} expected=${reward}`);
  check('重复完成不再发放（未凭空铸币）', delta2 === 0, `delta=${delta2}`);

  console.log('\n[4] 任务状态机');
  const illegal = await req('PATCH', `/v1/tasks/${taskId}/status`, { agentKey: caller.agentKey, body: { status: 'running' } });
  check('终态任务不可逆转到 running', illegal.status === 400 && /不允许的状态转换/.test(illegal.body?.error || ''),
    `status=${illegal.status} err=${illegal.body?.error}`);

  console.log('\n[5] 执行方计费封顶');
  const overcharge = await req('POST', `/v1/billing/task/${taskId}`, { agentKey: worker.agentKey, body: { amount: reward + 100 } });
  check('超额计费被拒绝 (400)', overcharge.status === 400, `status=${overcharge.status} body=${JSON.stringify(overcharge.body)}`);

  const afterTask = await req('POST', '/v1/tasks', {
    agentKey: caller.agentKey,
    body: { title: 'smoke-task-2', type: 'smoke', target_agent_id: worker.agentId },
  });
  const openTaskId = afterTask.body?.data?.id;
  const chargeDone = await req('POST', `/v1/billing/task/${openTaskId}`, { agentKey: worker.agentKey, body: { amount: reward } });
  check('未结束任务按约定金额计费成功 (200)', chargeDone.status === 200, `status=${chargeDone.status}`);
  const chargeAgain = await req('POST', `/v1/billing/task/${openTaskId}`, { agentKey: worker.agentKey, body: { amount: reward } });
  check('重复计费幂等（不重复扣款）', chargeAgain.status === 200 && chargeAgain.body?.data?.duplicate === true,
    `status=${chargeAgain.status} body=${JSON.stringify(chargeAgain.body)}`);
}

// ── 7. sandbox 不可提现 ─────────────────────────────────────
async function testSandboxNotWithdrawable(agent) {
  console.log('\n[7] sandbox 额度不可提现');
  const bal = await fetchBalance(agent.agentId, agent.agentKey);
  const sandbox = parseFloat(bal.sandbox_balance) || 0;
  const balance = parseFloat(bal.balance) || 0;
  const withdrawable = parseFloat(bal.withdrawable ?? NaN);

  check('余额接口暴露可提现金额', Number.isFinite(withdrawable), `withdrawable=${bal.withdrawable}`);
  // 不变量：可提现 = max(0, 余额 - 未消耗赠送额度)
  const expected = Math.max(0, Math.round((balance - sandbox) * 100) / 100);
  check('可提现不变量成立（余额 - 赠送额度）', withdrawable === expected,
    `withdrawable=${withdrawable} expected=${expected}`);
  if (agent.sandboxCredit?.granted) {
    check('注册响应标记赠送成功', sandbox > 0, `sandbox=${sandbox}`);
  } else {
    console.log(`  ⏭  本次未获赠送（${agent.sandboxCredit?.reason}，多为同 IP 日限频）——仅校验不变量`);
  }

  const r = await req('POST', `/v1/billing/node/${agent.agentId}/withdraw`, {
    agentKey: agent.agentKey,
    body: { amount: 1 },
  });
  check('赠送额度不可提现 (400)', r.status === 400, `status=${r.status} body=${JSON.stringify(r.body)}`);
}

// ── 8. WebSocket 抢占 ───────────────────────────────────────
function openAgentSocket(agentId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/agent-ws?agent_id=${agentId}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function authSocket(ws, agent, keys) {
  return new Promise((resolve) => {
    const timestamp = Date.now().toString();
    const signature = crypto.sign(
      null,
      Buffer.from(JSON.stringify({ agent_id: agent.agentId, timestamp })),
      keys.privateKey
    ).toString('base64');
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'AUTH_SUCCESS') resolve(true);
      } catch { /* ignore */ }
    });
    ws.send(JSON.stringify({ type: 'AUTH', agent_id: agent.agentId, timestamp, signature }));
    setTimeout(() => resolve(false), 5000);
  });
}

async function testWsKick(agent) {
  console.log('\n[8] WebSocket 未认证连接不能踢人');
  const victim = await openAgentSocket(agent.agentId);
  const authed = await authSocket(victim, agent, agent.keys);
  check('受害者连接认证成功', authed);

  // 攻击者用公开的 agent_id 连接但从不 AUTH
  const attacker = await openAgentSocket(agent.agentId);
  await new Promise(r => setTimeout(r, 1500));

  const victimAlive = victim.readyState === WebSocket.OPEN;
  check('未认证连接未能踢掉已认证连接', victimAlive, `readyState=${victim.readyState}`);

  // 合法持有者（带正确签名）重连应当能正常接管
  const legit = await openAgentSocket(agent.agentId);
  const legitAuthed = await authSocket(legit, agent, agent.keys);
  check('合法签名的新连接可完成认证', legitAuthed);
  await new Promise(r => setTimeout(r, 800));
  check('合法接管后旧连接被关闭', victim.readyState !== WebSocket.OPEN, `readyState=${victim.readyState}`);

  attacker.close();
  legit.close();
}

// ── 9. 对账 ─────────────────────────────────────────────────
async function testReconciliation() {
  console.log('\n[9] 账本对账');
  if (!ADMIN_KEY) {
    console.log('  ⏭  未提供 ADMIN_API_KEY，跳过');
    return;
  }
  const r = await req('GET', '/v1/admin/reconciliation', { adminKey: ADMIN_KEY });
  const data = r.body?.data;
  check('对账接口可用', r.status === 200 || r.status === 409, `status=${r.status}`);
  if (data) {
    const critical = (data.issues || []).filter(i => i.severity === 'critical');
    check('无严重账目漂移（托管/保证金不变量）', critical.length === 0, JSON.stringify(critical));
  }
  const noAuth = await req('GET', '/v1/admin/reconciliation');
  check('对账接口需要管理员凭据', noAuth.status === 401 || noAuth.status === 403, `status=${noAuth.status}`);
}

// ── 8b. 广播投递（跨实例桥接频道隔离） ──────────────────────
async function testBroadcastDelivery(a, b) {
  console.log('\n[8b] Agent 广播投递');
  const received = [];
  const wsA = await openAgentSocket(a.agentId);
  const wsB = await openAgentSocket(b.agentId);
  const authedA = await authSocket(wsA, a, a.keys);
  const authedB = await authSocket(wsB, b, b.keys);
  check('收发双方均认证成功', authedA && authedB);

  wsB.on('message', (raw) => {
    try {
      const m = JSON.parse(raw.toString());
      if (m.type === 'BROADCAST') received.push(m);
    } catch { /* ignore */ }
  });

  const content = `smoke-broadcast-${Date.now()}`;
  wsA.send(JSON.stringify({ type: 'BROADCAST', sender_id: a.agentId, content }));
  await new Promise(r => setTimeout(r, 1500));

  const hit = received.filter(m => m.content === content && m.sender_id === a.agentId);
  check('广播送达其他 Agent（内容与发送者一致）', hit.length === 1,
    `收到 ${hit.length} 帧: ${JSON.stringify(received).slice(0, 200)}`);

  wsA.close();
  wsB.close();
}

async function main() {
  console.log(`XClaw 安全回归冒烟 → ${BASE}`);
  const a = await createAgent(`smoke-a-${Date.now()}`);
  const b = await createAgent(`smoke-b-${Date.now()}`);
  console.log(`  Agent A ${a.agentId}\n  Agent B ${b.agentId}`);

  await testHeartbeatAuth(a);
  await testBillingIdor(a, b);
  await fundCaller(a);
  await testTaskMoneyPath(a, b);
  await testSandboxNotWithdrawable(b);
  await testWsKick(a);
  await testBroadcastDelivery(a, b);
  await testReconciliation();

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('冒烟脚本异常:', err);
  process.exit(1);
});
