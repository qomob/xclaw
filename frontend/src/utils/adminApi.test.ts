import { describe, test, expect, beforeEach } from 'vitest';
import { getStoredAdminKey, setStoredAdminKey, clearStoredAdminKey } from '../utils/adminApi';

describe('admin key storage', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    clearStoredAdminKey();
    localStorage.clear();
    sessionStorage.clear();
  });

  test('stores the key in sessionStorage, not localStorage', () => {
    setStoredAdminKey('ak_admin_secret');
    expect(sessionStorage.getItem('xclaw_admin_api_key')).toBe('ak_admin_secret');
    expect(localStorage.getItem('xclaw_admin_api_key')).toBeNull();
  });

  test('reads back the stored key', () => {
    setStoredAdminKey('ak_admin_secret');
    expect(getStoredAdminKey()).toBe('ak_admin_secret');
  });

  test('migrates a legacy localStorage key into sessionStorage and deletes the durable copy', () => {
    localStorage.setItem('xclaw_admin_api_key', 'ak_legacy');
    expect(getStoredAdminKey()).toBe('ak_legacy');
    expect(localStorage.getItem('xclaw_admin_api_key')).toBeNull();
    expect(sessionStorage.getItem('xclaw_admin_api_key')).toBe('ak_legacy');
  });

  test('clear removes both memory and storage copies', () => {
    setStoredAdminKey('ak_admin_secret');
    clearStoredAdminKey();
    expect(getStoredAdminKey()).toBe('');
    expect(sessionStorage.getItem('xclaw_admin_api_key')).toBeNull();
    expect(localStorage.getItem('xclaw_admin_api_key')).toBeNull();
  });
});
