import { resolve } from 'node:path';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { buildApp } from '../server/app';
import { prepareRegtestFixture, REGTEST_COOKIE } from './regtest-rpc';

await prepareRegtestFixture();
// Keep the tested assets immutable if another local task rebuilds dist.
const staticDir = await mkdtemp(resolve(tmpdir(), 'tensorcash-wallet-e2e-'));
await cp(resolve('dist'), staticDir, { recursive: true });
const app = await buildApp({
  network: 'regtest', rpcUrl: 'http://127.0.0.1:19453', cookieFile: REGTEST_COOKIE,
  allowedOrigins: ['http://127.0.0.1:4173'], staticDir,
  allowWatchWalletCreation: true, watchWallet: 'wallet-web-watch',
  requestTimeoutMs: 30000, logger: false,
  // Exercise the public wallet's two-confirmation policy on isolated coins.
  minConfirmations: 2,
  // This isolated loopback test process runs several browser profiles in sequence.
  syncRateLimit: 500, rateLimit: 1000,
});
await app.listen({ host: '127.0.0.1', port: 4173 });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  void app.close().then(() => rm(staticDir, { recursive: true, force: true })).then(() => process.exit(0));
});
