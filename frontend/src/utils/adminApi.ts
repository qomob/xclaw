/**
 * 管理员 API 工具。
 *
 * 后端 verifyApiKey 读取 `Authorization` 头并严格比对完整 API Key
 * （不带 Bearer 前缀）。之前 AdminDashboard 发送 X-Admin-API-Key 头，
 * 与后端不匹配导致管理台始终 401，这里统一修复。
 *
 * 存储策略（安全）：
 *   - 主存：模块内内存变量，页面生命周期内有效，任何持久化介质都不落盘
 *   - 备份：sessionStorage（仅当前标签页、关闭标签即失效），用于刷新后免重输
 *   - 历史 localStorage 中的密钥会被主动清除（XSS 可长期窃取的持久化副本）
 * 注意：仍是浏览器端持有主密钥，管理台应仅在受信网络 + 独立浏览器配置中使用；
 * 长期方案是后端签发短时效 admin session。
 */
const API_KEY_STORAGE = 'xclaw_admin_api_key';
const LEGACY_LOCAL_STORAGE = 'xclaw_admin_api_key';

function migrateLegacyStorage() {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem(LEGACY_LOCAL_STORAGE)) {
      // 迁移：旧的持久化密钥只保留到当前标签页，随后从 localStorage 删除
      if (!sessionStorage.getItem(API_KEY_STORAGE)) {
        sessionStorage.setItem(API_KEY_STORAGE, localStorage.getItem(LEGACY_LOCAL_STORAGE) || '');
      }
      localStorage.removeItem(LEGACY_LOCAL_STORAGE);
    }
  } catch {
    /* 隐私模式下存储不可用：忽略 */
  }
}

let memoryKey = '';

export function getStoredAdminKey(): string {
  if (memoryKey) return memoryKey;
  migrateLegacyStorage();
  try {
    memoryKey = sessionStorage.getItem(API_KEY_STORAGE) || '';
  } catch {
    memoryKey = '';
  }
  return memoryKey;
}

export function setStoredAdminKey(key: string) {
  memoryKey = key;
  migrateLegacyStorage();
  try {
    sessionStorage.setItem(API_KEY_STORAGE, key);
  } catch {
    /* 隐私模式下仅内存持有 */
  }
}

export function clearStoredAdminKey() {
  memoryKey = '';
  try {
    sessionStorage.removeItem(API_KEY_STORAGE);
    localStorage.removeItem(LEGACY_LOCAL_STORAGE);
  } catch {
    /* 忽略 */
  }
}

export async function adminFetch<T>(endpoint: string, apiKey: string, init: RequestInit = {}): Promise<T> {
  const base = import.meta.env.VITE_API_URL || '';
  const res = await fetch(`${base}${endpoint}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: apiKey,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error('AUTH_FAILED');
    }
    const body = await res.json().catch(() => ({ message: 'Request failed' }));
    throw new Error(body.message || `HTTP ${res.status}`);
  }
  return res.json();
}

/** 用管理员 Key 验证身份（可复用于各管理页面的登录门） */
export async function validateAdminKey(apiKey: string): Promise<boolean> {
  try {
    await adminFetch('/v1/admin/dashboard?check=1', apiKey);
    return true;
  } catch {
    return false;
  }
}
