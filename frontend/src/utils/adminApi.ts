/**
 * 管理员 API 工具。
 *
 * 后端 verifyApiKey 读取 `Authorization` 头并严格比对完整 API Key
 * （不带 Bearer 前缀）。之前 AdminDashboard 发送 X-Admin-API-Key 头，
 * 与后端不匹配导致管理台始终 401，这里统一修复。
 */
const API_KEY_STORAGE = 'xclaw_admin_api_key';

export function getStoredAdminKey(): string {
  return localStorage.getItem(API_KEY_STORAGE) || '';
}

export function setStoredAdminKey(key: string) {
  localStorage.setItem(API_KEY_STORAGE, key);
}

export function clearStoredAdminKey() {
  localStorage.removeItem(API_KEY_STORAGE);
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
