import { jest, describe, test, expect, beforeEach } from '@jest/globals';

// 环境变量必须在模块导入前设置（模块顶层读取）
process.env.WITHDRAWAL_CALLBACK_SECRET = 'test-callback-secret';
process.env.WITHDRAWAL_EXECUTOR_SECRET = 'test-executor-secret';
process.env.WITHDRAWAL_EXECUTOR_URL = 'http://executor.test';

const mockClientQuery = jest.fn();
const mockRelease = jest.fn();
const mockPoolQuery = jest.fn();
const mockCreditAccount = jest.fn().mockResolvedValue(10);
const mockInvalidateCache = jest.fn();

jest.unstable_mockModule('../../core/dependencies.js', () => ({
  getPostgres: jest.fn(() => ({
    connect: jest.fn(() => Promise.resolve({ query: mockClientQuery, release: mockRelease })),
    query: mockPoolQuery,
  })),
}));

jest.unstable_mockModule('../../core/httpGuard.js', () => ({
  safeFetch: jest.fn(),
}));

jest.unstable_mockModule('../../billing/index.js', () => ({
  creditAccount: mockCreditAccount,
  invalidateBalanceCache: mockInvalidateCache,
}));

const executor = await import('../../services/withdrawalExecutor.js');

describe('withdrawalExecutor', () => {
  beforeEach(() => {
    mockClientQuery.mockReset();
    mockRelease.mockReset();
    mockPoolQuery.mockReset();
    mockCreditAccount.mockReset().mockResolvedValue(10);
    mockInvalidateCache.mockReset();
  });

  test('buildHmac 结果确定且可复现', () => {
    const body = JSON.stringify({ a: 1 });
    expect(executor.buildHmac(body, 'secret')).toBe(executor.buildHmac(body, 'secret'));
    expect(executor.buildHmac(body, 'secret')).not.toBe(executor.buildHmac(body, 'other'));
  });

  test('verifyCallbackSignature 正确签名通过、篡改与长度不等拒绝', () => {
    const body = JSON.stringify({ status: 'completed', tx_hash: '0xabc' });
    const sig = executor.buildHmac(body, 'test-callback-secret');
    expect(executor.verifyCallbackSignature(body, sig)).toBe(true);
    expect(executor.verifyCallbackSignature(body, 'deadbeef')).toBe(false);
    // 长度不等不抛异常
    expect(executor.verifyCallbackSignature(body, 'short')).toBe(false);
  });

  test('processPendingWithdrawals 无待处理提现返回空', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const result = await executor.processPendingWithdrawals({ limit: 10 });
    expect(result).toEqual([]);
  });

  test('回调 completed：写入 tx_hash 并置终态', async () => {
    mockClientQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'w1', node_id: 'n1', amount: '0.5', metadata: '{}' }] }) // SELECT FOR UPDATE
      .mockResolvedValueOnce({}) // UPDATE completed
      .mockResolvedValueOnce({}); // COMMIT

    const result = await executor.handleWithdrawalCallback('w1', { status: 'completed', tx_hash: '0xabc' });

    expect(result.success).toBe(true);
    expect(result.status).toBe('completed');
    expect(mockCreditAccount).not.toHaveBeenCalled();
    expect(mockInvalidateCache).toHaveBeenCalledWith('n1');
  });

  test('回调 failed：自动退款（本金+手续费）并记录退款流水', async () => {
    mockClientQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'w2', node_id: 'n2', amount: '0.5', metadata: JSON.stringify({ fee: 0.05 }) }] }) // SELECT FOR UPDATE
      .mockResolvedValueOnce({}) // creditAccount
      .mockResolvedValueOnce({ rows: [] }) // INSERT refund transaction
      .mockResolvedValueOnce({}) // UPDATE failed
      .mockResolvedValueOnce({}); // COMMIT

    const result = await executor.handleWithdrawalCallback('w2', { status: 'failed', error: 'insufficient gas' });

    expect(result.success).toBe(true);
    expect(result.status).toBe('failed');
    expect(mockCreditAccount).toHaveBeenCalledTimes(1);
    // 本金 0.5 + 手续费 0.05
    expect(mockCreditAccount.mock.calls[0][2]).toBe(0.55);
    expect(mockInvalidateCache).toHaveBeenCalledWith('n2');
  });

  test('重复回调：状态不匹配返回 409 语义（current 状态）', async () => {
    mockClientQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT FOR UPDATE（空）
      .mockResolvedValueOnce({}); // ROLLBACK
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ status: 'completed' }] });

    const result = await executor.handleWithdrawalCallback('w3', { status: 'completed' });

    expect(result.success).toBe(false);
    expect(result.current).toBe('completed');
  });
});
