import type { WalletNetwork } from '../src/shared/types';
import type { Rpc } from './rpc';

export const MAINNET_GENESIS = '8fe43be4634dc48def074fa840e25a71bbdc32576eb29abf3ce2458605343720';
export const REGTEST_GENESIS = 'cf63c021e5a8ea0bc04cf7b12ab12e0a7902ef2dae5bdd8cbb3a0d41c3345da4';
export interface GatewayConfig {
  network: WalletNetwork; rpcUrl: string; cookieFile?: string;
  rpcUsername?: string; rpcPassword?: string;
  explorerUrl?: string; seedUrl?: string; allowedOrigins: string[];
  staticDir?: string; requireRelease?: boolean; watchWallet?: string; allowWatchWalletCreation?: boolean;
  expectedGenesis?: string; maxTipAgeSeconds?: number; minConfirmations?: number;
  coinbaseMaturity?: number; maximumFeeUnits?: string; maximumFeeRate?: string;
  requestTimeoutMs?: number; maxHistoryPages?: number; maxHistoryTransactions?: number;
  maxWatchedAddresses?: number; logger?: boolean; rpc?: Rpc; fetch?: typeof fetch;
  maxMempoolTransactions?: number; maxMempoolHexCharacters?: number; maxMempoolEdges?: number;
  syncRateLimit?: number; rateLimit?: number;
}
export type ResolvedConfig = GatewayConfig & {
  explorerUrl: string; seedUrl: string; watchWallet: string; expectedGenesis: string;
  maxTipAgeSeconds: number; minConfirmations: number; coinbaseMaturity: number;
  maximumFeeUnits: string; maximumFeeRate: string; requestTimeoutMs: number;
  maxHistoryPages: number; maxHistoryTransactions: number; maxWatchedAddresses: number;
  maxMempoolTransactions: number; maxMempoolHexCharacters: number; maxMempoolEdges: number;
};
export function resolveConfig(input: GatewayConfig): ResolvedConfig {
  const config: ResolvedConfig = {
    explorerUrl: 'https://tscscan.xyz', seedUrl: 'https://mempool.tensorcash.org',
    watchWallet: 'wallet-web-watch', expectedGenesis: input.network === 'mainnet' ? MAINNET_GENESIS : REGTEST_GENESIS,
    maxTipAgeSeconds: input.network === 'mainnet' ? 7200 : 86400,
    minConfirmations: input.network === 'mainnet' ? 2 : 1, coinbaseMaturity: 100, maximumFeeUnits: '1000000', maximumFeeRate: '100',
    requestTimeoutMs: 10000, maxHistoryPages: 20, maxHistoryTransactions: 500, maxWatchedAddresses: 10000,
    maxMempoolTransactions: 5000, maxMempoolHexCharacters: 16_000_000, maxMempoolEdges: 20 * (input.maxMempoolTransactions ?? 5000),
    ...input,
  };
  if (!['mainnet', 'regtest'].includes(config.network)) throw new Error('Unsupported gateway network');
  for (const value of [config.rpcUrl, config.explorerUrl, config.seedUrl]) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid provider URL');
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Remote providers require HTTPS');
  }
  if (!/^[0-9a-f]{64}$/.test(config.expectedGenesis)) throw new Error('Invalid genesis');
  if (config.expectedGenesis !== (config.network === 'mainnet' ? MAINNET_GENESIS : REGTEST_GENESIS)) throw new Error('Genesis differs from supported network');
  if (!config.allowedOrigins.length || config.allowedOrigins.some(o => new URL(o).origin !== o)) throw new Error('Explicit canonical allowed origins required');
  for (const n of [config.maxTipAgeSeconds, config.minConfirmations, config.coinbaseMaturity, config.requestTimeoutMs, config.maxHistoryPages, config.maxHistoryTransactions, config.maxWatchedAddresses, config.maxMempoolTransactions, config.maxMempoolHexCharacters, config.maxMempoolEdges]) {
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error('Invalid gateway limit');
  }
  if (config.maxHistoryPages > 100 || config.maxHistoryTransactions > 5000 || config.requestTimeoutMs > 60000 || config.maxWatchedAddresses > 100000) throw new Error('Gateway limit exceeds hard bound');
  if (config.maxMempoolTransactions > 100000 || config.maxMempoolHexCharacters > 64_000_000 || config.maxMempoolEdges > 2_000_000) throw new Error('Gateway limit exceeds hard bound');
  if (!/^[1-9][0-9]{0,11}$/.test(config.maximumFeeUnits) || !/^[1-9][0-9]{0,5}$/.test(config.maximumFeeRate)) throw new Error('Invalid gateway fee cap');
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(config.watchWallet)) throw new Error('Invalid watch-only wallet name');
  for (const limit of [config.syncRateLimit ?? 60, config.rateLimit ?? 90]) if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2000) throw new Error('Invalid request rate limit');
  if (config.network === 'regtest' || config.allowWatchWalletCreation) {
    const rpc = new URL(config.rpcUrl);
    if (config.network !== 'regtest' || !['localhost', '127.0.0.1', '[::1]'].includes(rpc.hostname) || rpc.port !== '19453') throw new Error('Watch-only operations are restricted to isolated regtest port 19453');
  }
  return config;
}
