import { OpenClaw, generateKeyPair, signWithKey } from './index.js';

// 支持通过 XCLAW_BASE_URL 环境变量指向任意服务端（默认本地 8081）
const c = new OpenClaw({ baseURL: process.env.XCLAW_BASE_URL || 'http://localhost:8081' });
let passed = 0, failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log('✅ ' + name);
    passed++;
  } catch (err) {
    console.log('❌ ' + name + ': ' + (err.message || err));
    failed++;
  }
}

// ─── Unit: key generation ────────────────────────────────────
await test('generateKeyPair', async () => {
  const keys = generateKeyPair();
  if (!keys.publicKey || keys.publicKey.length < 40) throw new Error('bad publicKey');
  if (!keys.privateKey || keys.privateKey.length < 40) throw new Error('bad privateKey');
});

await test('signWithKey', async () => {
  const keys = generateKeyPair();
  const sig = signWithKey(keys.privateKey, 'hello xclaw');
  if (!sig || sig.length < 40) throw new Error('bad signature');
});

// ─── Integration: live API ───────────────────────────────────
await test('GET /health', async () => {
  const r = await c._http.get('/health');
  if (r.status !== 'ok') throw new Error(JSON.stringify(r));
});

await test('agent.online', async () => {
  const r = await c.agent.online();
  if (!r.success) throw new Error(JSON.stringify(r));
});

await test('topology.getState', async () => {
  const r = await c.topology.getState();
  if (!r.nodes && !r.links) throw new Error('no topology data');
});

await test('stats.global', async () => {
  const r = await c.stats.global();
  if (!r.success) throw new Error(JSON.stringify(r));
});

await test('stats.memory', async () => {
  const r = await c.stats.memory();
  if (!r.success) throw new Error(JSON.stringify(r));
});

await test('stats.relationships', async () => {
  const r = await c.stats.relationships();
  if (!r.success) throw new Error(JSON.stringify(r));
});

await test('skill.categories', async () => {
  const r = await c.skill.categories();
  if (!r.success) throw new Error(JSON.stringify(r));
});

await test('search.get', async () => {
  const r = await c.search.get('agent');
  if (!r.success) throw new Error(JSON.stringify(r));
});

await test('search.query (POST)', async () => {
  const r = await c.search.query('NLP translation', { limit: 3 });
  if (!r.success) throw new Error(JSON.stringify(r));
});

await test('marketplace.stats', async () => {
  const r = await c.marketplace.stats();
  if (!r.success) throw new Error(JSON.stringify(r));
});

await test('marketplace.featured', async () => {
  const r = await c.marketplace.featured(3);
  if (!r.success) throw new Error(JSON.stringify(r));
});

await test('marketplace.listings', async () => {
  const r = await c.marketplace.listings({ limit: 5 });
  if (!r.success) throw new Error(JSON.stringify(r));
});

await test('social-graph', async () => {
  const r = await c.topology.socialGraph();
  if (!r.success) throw new Error(JSON.stringify(r));
});

await test('events.types', async () => {
  const r = await c.events.types();
  if (!r.success) throw new Error(JSON.stringify(r));
});

await test('review.topRated', async () => {
  const r = await c.review.topRated(5);
  if (!r.success) throw new Error(JSON.stringify(r));
});

await test('review.categories', async () => {
  const r = await c.review.categories();
  if (!r.success) throw new Error(JSON.stringify(r));
});

await test('agent.discover', async () => {
  const r = await c.agent.discover({ limit: 3 });
  if (!r.success) throw new Error(JSON.stringify(r));
});

await test('agent.search', async () => {
  const r = await c.agent.search({ query: 'agent' });
  if (!r.success) throw new Error(JSON.stringify(r));
});

await test('billing.balance (expect auth error)', async () => {
  try {
    await c.billing.balance();
    // If it succeeds, that's fine too
  } catch (err) {
    if (err.status === 401 || err.code === 'HTTP_401') {
      // Expected: no auth
    } else {
      throw err;
    }
  }
});

await test('webhook.list (expect auth error)', async () => {
  try {
    await c.webhook.list();
  } catch (err) {
    if (err.status === 401 || err.code === 'HTTP_401' || err.status === 403 || err.code === 'HTTP_403') {
      // Expected
    } else {
      throw err;
    }
  }
});

// ─── Summary ─────────────────────────────────────────────────
console.log(`\n=== SDK Integration Test: ${passed}/${passed + failed} passed ===`);
if (failed > 0) process.exit(1);
