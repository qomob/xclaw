import React, { useState, useEffect, useCallback } from 'react';
import {
  fetchBalance, fetchTransactions,
  request, getAgentIdFromToken
} from '../utils/api';

type Tab = 'overview' | 'transactions' | 'wallets' | 'topup';

interface BalanceData {
  balance?: number;
  currency?: string;
}

interface Transaction {
  id: string;
  amount: number;
  type: string;
  status: string;
  reason?: string;
  created_at: string;
}

interface Wallet {
  wallet_id: string;
  chain: string;
  address: string;
  label?: string;
  is_primary: boolean;
  verified_at?: string;
}

const card = 'bg-slate-900 border border-slate-800 rounded-xl';
const textSecondary = 'text-slate-400';

export default function FinanceCenter() {
  const [tab, setTab] = useState<Tab>('overview');
  const [balance, setBalance] = useState<BalanceData | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [balRes, txRes] = await Promise.allSettled([
        fetchBalance(),
        fetchTransactions({ limit: 30 }),
      ]);
      if (balRes.status === 'fulfilled' && balRes.value.success) {
        setBalance(balRes.value.data || {});
      }
      if (txRes.status === 'fulfilled' && txRes.value.success) {
        setTransactions(txRes.value.data || []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const loadWallets = useCallback(async () => {
    try {
      const nodeId = getAgentIdFromToken();
      if (!nodeId) return;
      const res = await request(`/v1/payment/wallets/${nodeId}`);
      if (res.success) setWallets(res.data || []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    loadData();
    loadWallets();
  }, [loadData, loadWallets]);

  const supportedChains = ['ethereum', 'bitcoin', 'usdt'];

  const chainMeta: Record<string, { symbol: string; label: string; color: string; bg: string }> = {
    ethereum: { symbol: 'ETH', label: 'Ethereum', color: 'text-blue-400', bg: 'bg-blue-500/20' },
    bitcoin:  { symbol: 'BTC', label: 'Bitcoin',  color: 'text-orange-400', bg: 'bg-orange-500/20' },
    usdt:     { symbol: 'USDT', label: 'Tether USD', color: 'text-green-400', bg: 'bg-green-500/20' },
  };

  const tabs: { key: Tab; label: string }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'transactions', label: 'Transactions' },
    { key: 'wallets', label: 'Multi-Chain Wallets' },
    { key: 'topup', label: 'Top Up' },
  ];

  return (
    <div className="h-full flex flex-col p-4 gap-4 overflow-y-auto">
      <div>
        <h1 className="text-lg font-bold text-white">
          💰 Finance Center
        </h1>
        <p className="text-xs mt-0.5 text-slate-400">
          Balance management, transactions, multi-chain wallets
        </p>
      </div>

      <div className="flex gap-1 shrink-0">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
              tab === t.key
                ? 'bg-brand-500 text-white'
                : 'text-slate-400 hover:text-white bg-slate-800'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="space-y-4">
          <div className={`${card} p-4`}>
            <h3 className="text-sm font-semibold mb-3 text-white">
              Account Balance
            </h3>
            <div className="flex items-end gap-2">
              <span className={`text-3xl font-bold ${
                (balance?.balance || 0) >= 0 ? 'text-green-400' : 'text-red-400'
              }`}>
                {balance?.balance?.toFixed(2) || '0.00'}
              </span>
              <span className="text-sm mb-1 text-slate-400">
                {balance?.currency || 'XCL'}
              </span>
            </div>
          </div>

          <div className={`${card} p-4`}>
            <h3 className="text-sm font-semibold mb-3 text-white">
              Recent Transactions
            </h3>
            {transactions.length === 0 ? (
              <div className="text-center py-6 text-xs text-slate-400">No transactions</div>
            ) : (
              <div className="space-y-2">
                {transactions.slice(0, 5).map(tx => (
                  <div key={tx.id} className="flex items-center justify-between p-2 rounded-lg bg-slate-800">
                    <div>
                      <span className={`text-xs font-medium ${
                        tx.type === 'topup' ? 'text-green-400' :
                        tx.type === 'charge' ? 'text-red-400' : 'text-brand-400'
                      }`}>
                        {tx.type === 'topup' ? '+' : tx.type === 'charge' ? '-' : ''}{tx.amount}
                      </span>
                      <span className="ml-2 text-[10px] text-slate-400">{tx.type}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                        tx.status === 'completed' ? 'bg-green-500/20 text-green-400' : 'bg-yellow-500/20 text-yellow-400'
                      }`}>
                        {tx.status}
                      </span>
                      <span className="text-[10px] text-slate-400">
                        {new Date(tx.created_at).toLocaleDateString('zh-CN')}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className={`${card} p-4`}>
            <h3 className="text-sm font-semibold mb-3 text-white">
              Multi-Chain Wallets ({wallets.length})
            </h3>
            {wallets.length === 0 ? (
              <div className="text-center py-6 text-xs text-slate-400">No bound wallets</div>
            ) : (
              <div className="space-y-2">
                {wallets.map(w => (
                  <div key={w.wallet_id} className="flex items-center justify-between p-2 rounded-lg bg-slate-800">
                    <div>
                      <span className={`text-xs font-medium ${chainMeta[w.chain]?.color || 'text-white'}`}>
                        {chainMeta[w.chain]?.symbol || w.chain}
                      </span>
                      {w.is_primary && (
                        <span className="ml-2 text-[10px] text-brand-400">Primary</span>
                      )}
                    </div>
                    <span className="text-[10px] font-mono text-slate-400">
                      {w.address.slice(0, 10)}...{w.address.slice(-6)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'transactions' && (
        <div className="space-y-2">
          {transactions.length === 0 ? (
            <div className={`${card} p-8 text-center text-xs text-slate-400`}>No transactions</div>
          ) : transactions.map(tx => (
            <div key={tx.id} className={`${card} p-3`}>
              <div className="flex items-center justify-between">
                <div>
                  <span className={`text-sm font-bold ${
                    tx.type === 'topup' ? 'text-green-400' :
                    tx.type === 'charge' ? 'text-red-400' : 'text-brand-400'
                  }`}>
                    {tx.type === 'topup' ? '+' : tx.type === 'charge' ? '-' : ''}{tx.amount} XCL
                  </span>
                  <span className="ml-2 text-xs text-slate-400">{tx.type}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                    tx.status === 'completed' ? 'bg-green-500/20 text-green-400' :
                    tx.status === 'pending' ? 'bg-yellow-500/20 text-yellow-400' :
                    'bg-red-500/20 text-red-400'
                  }`}>
                    {tx.status}
                  </span>
                </div>
              </div>
              {tx.reason && (
                <p className="text-[10px] mt-1 text-slate-400">{tx.reason}</p>
              )}
              <p className="text-[10px] mt-1 text-slate-600">
                {new Date(tx.created_at).toLocaleString('zh-CN')}
              </p>
            </div>
          ))}
        </div>
      )}

      {tab === 'wallets' && (
        <div className="space-y-3">
          <div className={`${card} p-4`}>
            <h3 className="text-sm font-semibold mb-3 text-white">
              Bound Wallets
            </h3>
            {wallets.length === 0 ? (
              <div className="text-center py-6 text-xs text-slate-400">No bound wallets</div>
            ) : (
              <div className="space-y-2">
                {wallets.map(w => (
                  <div key={w.wallet_id} className="flex items-center justify-between p-3 rounded-lg bg-slate-800">
                    <div className="flex items-center gap-3">
                      <span className={`text-xs font-bold px-2 py-1 rounded ${
                        chainMeta[w.chain]?.bg || 'bg-slate-500/20'
                      } ${chainMeta[w.chain]?.color || 'text-slate-400'}`}>
                        {chainMeta[w.chain]?.symbol || w.chain}
                      </span>
                      <span className="text-xs font-mono text-slate-400">
                        {w.address.slice(0, 12)}...{w.address.slice(-8)}
                      </span>
                    </div>
                    {w.is_primary && (
                      <span className="text-[10px] px-1.5 py-0.5 bg-brand-500/20 text-brand-400 rounded">Primary</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className={`${card} p-4`}>
            <h3 className="text-sm font-semibold mb-3 text-white">
              Supported Chains
            </h3>
            <div className="grid grid-cols-3 gap-2">
              {supportedChains.map(chain => (
                <div key={chain} className="text-center p-3 rounded-lg bg-slate-800">
                  <div className={`text-xs font-bold ${chainMeta[chain]?.color || 'text-white'}`}>
                    {chainMeta[chain]?.symbol || chain}
                  </div>
                  <div className="text-[10px] text-slate-400">
                    {chainMeta[chain]?.label || chain}
                  </div>
                  <div className="text-[10px] text-slate-500">
                    {wallets.some(w => w.chain === chain) ? 'Bound' : 'Not bound'}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {tab === 'topup' && (
        <div className={`${card} p-4 max-w-lg`}>
          <h3 className="text-sm font-semibold mb-3 text-white">
            Top Up
          </h3>
          <div className="space-y-3 text-xs text-slate-400 leading-relaxed">
            <p>
              余额充值由平台管理员操作：管理员通过
              <code className="mx-1 px-1.5 py-0.5 rounded bg-slate-800 text-brand-400 font-mono">
                POST /v1/billing/topup
              </code>
              为指定 Agent 记账（需管理员 API Key）。
            </p>
            <p>
              Agent 侧可以发起的是链上充值申请
              <code className="mx-1 px-1.5 py-0.5 rounded bg-slate-800 text-brand-400 font-mono">
                POST /v1/payment/deposit
              </code>
              ，由管理员确认链上交易后入账。钱包地址可在「Multi-Chain Wallets」页绑定。
            </p>
            <p className="text-slate-500">
              完整配置说明见
              <a
                href="https://github.com/qomob/xclaw/blob/main/docs/payment-config.md"
                target="_blank"
                rel="noopener noreferrer"
                className="ml-1 text-brand-400 hover:underline"
              >
                Payment Configuration
              </a>
              。
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
