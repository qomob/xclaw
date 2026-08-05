// 出站 HTTP 请求安全防护（SSRF）
// 阻止访问私网/回环/链路本地/保留地址，并强制超时
import dns from 'dns';
import net from 'net';
import logger from '../services/loggerService.js';

// IPv4 私网/保留网段
const BLOCKED_RANGES = [
  { min: 0x00000000, max: 0x00ffffff },  // 0.0.0.0/8
  { min: 0x0a000000, max: 0x0affffff },  // 10.0.0.0/8
  { min: 0x7f000000, max: 0x7fffffff },  // 127.0.0.0/8
  { min: 0x64400000, max: 0x647fffff },  // 100.64.0.0/10 (CGNAT)
  { min: 0xa9fe0000, max: 0xa9feffff },  // 169.254.0.0/16 (link-local)
  { min: 0xac100000, max: 0xac1fffff },  // 172.16.0.0/12
  { min: 0xc0a80000, max: 0xc0a8ffff },  // 192.168.0.0/16
  { min: 0xe0000000, max: 0xffffffff },  // 224.0.0.0/4 + 240.0.0.0/4 + 广播
];

function isPrivateIPv4(addr) {
  const parts = addr.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const num = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  return BLOCKED_RANGES.some(r => num >= r.min && num <= r.max);
}

function isPrivateIPv6(addr) {
  const lower = addr.toLowerCase();
  return lower === '::'
    || lower === '::1'
    || lower.startsWith('fc')   // fc00::/7 ULA
    || lower.startsWith('fd')
    || lower.startsWith('fe8')  // fe80::/10 link-local
    || lower.startsWith('fe9')
    || lower.startsWith('fea')
    || lower.startsWith('feb');
}

async function resolveAndGuard(hostname) {
  const addresses = await new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true }, (err, addrs) => {
      if (err) return reject(err);
      resolve(addrs.map(a => a.address));
    });
  });

  for (const addr of addresses) {
    const family = net.isIP(addr);
    if (family === 4 && isPrivateIPv4(addr)) {
      throw new Error(`Blocked private/reserved IPv4: ${addr}`);
    }
    if (family === 6 && isPrivateIPv6(addr)) {
      throw new Error(`Blocked private/link-local IPv6: ${addr}`);
    }
  }
}

/**
 * 安全的出站 fetch：仅允许 http(s)、解析后校验目标地址非私网、强制超时
 * @param {string} url
 * @param {object} [options] fetch options
 * @param {number} [timeoutMs=10000]
 * @returns {Promise<Response>}
 */
export async function safeFetch(url, options = {}, timeoutMs = 10000) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http(s) URLs are allowed');
  }

  await resolveAndGuard(parsed.hostname);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    logger.warn('[httpGuard] Outbound request failed', { url: parsed.origin, error: err.message });
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
