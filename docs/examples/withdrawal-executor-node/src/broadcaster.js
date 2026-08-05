// 广播层：ethers v6 真实以太坊广播；未配置 RPC/私钥时降级为模拟（并给出警告）
import crypto from 'node:crypto';
import { config } from './config.js';

let wallet = null;

export function isLive() {
  return Boolean(config.rpcUrl && config.privateKey);
}

async function initWallet() {
  if (wallet) return wallet;
  const { JsonRpcProvider, Wallet } = await import('ethers');
  const provider = new JsonRpcProvider(config.rpcUrl);
  wallet = new Wallet(config.privateKey, provider);
  return wallet;
}

/** 模拟广播（本地联调用） */
export async function broadcastSimulated(withdrawal) {
  console.warn('[broadcaster] EXECUTOR_RPC_URL/PRIVATE_KEY 未配置，使用模拟广播（生产必配）');
  const digest = crypto
    .createHash('sha256')
    .update(String(withdrawal.withdrawal_id))
    .digest('hex')
    .slice(0, 58);
  return { txHash: `0xSIM${digest}`, simulated: true };
}

/**
 * 真实以太坊广播
 * - 原生币（ETH/MATIC）：直接转账
 * - ERC-20（USDT 等）：需扩展为合约 transfer（示例按 6 位小数预置，可自行替换）
 */
export async function broadcastEthers(withdrawal) {
  const { parseEther, parseUnits } = await import('ethers');
  const currency = String(withdrawal.currency || 'ETH').toUpperCase();
  const num = Number(withdrawal.amount);
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error(`无法解析金额: ${withdrawal.amount} ${withdrawal.currency}`);
  }
  const value = currency === 'ETH' || currency === 'MATIC'
    ? parseEther(String(num))
    : parseUnits(String(num), 6);

  const w = await initWallet();
  const tx = await w.sendTransaction({ to: withdrawal.to_address, value });
  console.log('[broadcaster] 已广播交易，等待回执:', tx.hash);
  const receipt = await tx.wait();
  return { txHash: receipt.hash, simulated: false };
}

