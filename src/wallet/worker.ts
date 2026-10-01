import { LocalWalletEngine } from './engine';
import { IndexedDbVaultStorage } from './storage';
const engine = new LocalWalletEngine(new IndexedDbVaultStorage());
const methods = new Set(['getMetadata', 'create', 'restore', 'unlock', 'lock', 'recordActivity', 'acknowledgeBackup', 'getAddresses', 'loadDisplayCache', 'saveDisplayCache', 'prepareTransfer', 'signTransfer', 'exportBackup', 'importBackup', 'revealMnemonic', 'changePassword', 'reset']);
let queue = Promise.resolve();
self.addEventListener('message', event => {
  const message = event.data;
  if (!message || !Number.isSafeInteger(message.id) || !methods.has(message.method) || !Array.isArray(message.args)) return;
  // Serial operations prevent lock/password-change/restore races and stale vault writes.
  queue = queue.then(async () => {
    try { const fn = engine[message.method as keyof LocalWalletEngine] as (...args: unknown[]) => Promise<unknown>; const value = await fn.apply(engine, message.args); self.postMessage({ id: message.id, value }); }
    catch (error) { self.postMessage({ id: message.id, error: error instanceof Error ? error.message : 'Wallet operation failed' }); }
  });
});
