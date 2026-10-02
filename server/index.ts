import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { buildApp } from './app';
import { MAINNET_GENESIS, REGTEST_GENESIS, type GatewayConfig } from './config';

export function configFromEnvironment(env: NodeJS.ProcessEnv = process.env): { config: GatewayConfig; host: string; port: number } {
  const network = env.WALLET_NETWORK || 'mainnet'; if (network !== 'mainnet' && network !== 'regtest') throw new Error('Unsupported WALLET_NETWORK');
  const host = env.WALLET_HOST || '127.0.0.1'; const port = Number(env.WALLET_PORT || '8790');
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) || !Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Gateway must bind a valid loopback address and port');
  const positive = (name: string, fallback: number) => { const value = env[name] === undefined ? fallback : Number(env[name]); if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${name}`); return value; };
  const maxMempoolTransactions = positive('WALLET_MAX_MEMPOOL_TRANSACTIONS', 5000);
  const config: GatewayConfig = {
    network, rpcUrl: env.CORE_RPC_URL || (network === 'mainnet' ? 'http://127.0.0.1:39242' : 'http://127.0.0.1:19453'),
    cookieFile: env.CORE_COOKIE_FILE || undefined,
    rpcUsername: env.CORE_RPC_USER, rpcPassword: env.CORE_RPC_PASSWORD,
    explorerUrl: env.WALLET_EXPLORER_URL || 'https://tscscan.xyz', seedUrl: env.WALLET_SEED_URL || 'https://mempool.tensorcash.org',
    allowedOrigins: (env.WALLET_ALLOWED_ORIGINS || `http://localhost:${port},http://127.0.0.1:${port}`).split(',').map(v => v.trim()).filter(Boolean),
    staticDir: env.WALLET_STATIC_DIR || resolve(fileURLToPath(new URL('../dist/', import.meta.url))),
    requireRelease: env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test',
    watchWallet: env.WALLET_WATCH_WALLET || 'wallet-web-watch', allowWatchWalletCreation: network === 'regtest' && env.WALLET_ALLOW_WATCH_CREATION === 'true',
    expectedGenesis: env.WALLET_GENESIS_HASH || (network === 'mainnet' ? MAINNET_GENESIS : REGTEST_GENESIS),
    maxTipAgeSeconds: positive('WALLET_MAX_TIP_AGE', network === 'mainnet' ? 7200 : 86400),
    minConfirmations: positive('WALLET_MIN_CONFIRMATIONS', network === 'mainnet' ? 2 : 1), coinbaseMaturity: 100,
    maximumFeeUnits: env.WALLET_MAX_FEE_UNITS || '1000000', maximumFeeRate: env.WALLET_MAX_FEE_RATE || '100',
    requestTimeoutMs: positive('WALLET_RPC_TIMEOUT_MS', 10000), maxHistoryPages: positive('WALLET_MAX_HISTORY_PAGES', 20),
    maxHistoryTransactions: positive('WALLET_MAX_HISTORY_TRANSACTIONS', 500), maxWatchedAddresses: positive('WALLET_MAX_WATCHED_ADDRESSES', 10000), logger: false,
    maxMempoolTransactions, maxMempoolHexCharacters: positive('WALLET_MAX_MEMPOOL_HEX_CHARACTERS', 16_000_000),
    maxMempoolEdges: positive('WALLET_MAX_MEMPOOL_EDGES', 20 * maxMempoolTransactions),
  };
  return { config, host, port };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { config, host, port } = configFromEnvironment(); const app = await buildApp(config);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
  await app.listen({ host, port }); process.stdout.write(`Wallet gateway listening on ${host}:${port} (${config.network})\n`);
}
