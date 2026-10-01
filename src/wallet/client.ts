import type { WalletEngine, WalletMetadata, WalletNetwork, SpendRequest, TransferPlan, SignedTransfer, AddressRecord } from '../shared/types';
import type { DisplayCacheInput, WalletDisplayCache } from './display-cache';
export class WalletEngineClient implements WalletEngine {
  private worker: Worker | null = null; private counter = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private getWorker() {
    if (!this.worker) { this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'tensorcash-wallet-signer' });
      this.worker.onmessage = event => { const { id, value, error } = event.data; const task = this.pending.get(id); if (!task) return; clearTimeout(task.timer); this.pending.delete(id); if (error) task.reject(new Error(error)); else task.resolve(value); };
      this.worker.onerror = () => this.terminate('Wallet worker failed; unlock again');
    }
    return this.worker;
  }
  private terminate(message: string) { this.worker?.terminate(); this.worker = null; for (const task of this.pending.values()) { clearTimeout(task.timer); task.reject(new Error(message)); } this.pending.clear(); }
  private call<T>(method: string, ...args: unknown[]): Promise<T> {
    const worker = this.getWorker(); const id = ++this.counter;
    return new Promise<T>((resolve, reject) => { const timer = setTimeout(() => this.terminate('Wallet operation timed out; unlock again'), 60_000); this.pending.set(id, { resolve: value => resolve(value as T), reject, timer }); worker.postMessage({ id, method, args }); });
  }
  getMetadata() { return this.call<WalletMetadata | null>('getMetadata'); }
  create(password: string, network: WalletNetwork) { return this.call<{ metadata: WalletMetadata; mnemonic: string }>('create', password, network); }
  restore(mnemonic: string, password: string, network: WalletNetwork) { return this.call<WalletMetadata>('restore', mnemonic, password, network); }
  unlock(password: string) { return this.call<WalletMetadata>('unlock', password); }
  loadDisplayCache() { return this.call<WalletDisplayCache | null>('loadDisplayCache'); }
  saveDisplayCache(input: DisplayCacheInput | null) { return this.call<void>('saveDisplayCache', input); }
  async lock() { this.terminate('Wallet locked'); }
  recordActivity() { return this.call<void>('recordActivity'); }
  acknowledgeBackup() { return this.call<WalletMetadata>('acknowledgeBackup'); }
  getAddresses(branch: 0 | 1, start: number, count: number) { return this.call<AddressRecord[]>('getAddresses', branch, start, count); }
  prepareTransfer(request: SpendRequest) { return this.call<TransferPlan>('prepareTransfer', request); }
  signTransfer(planId: string) { return this.call<SignedTransfer>('signTransfer', planId); }
  exportBackup(password: string) { return this.call<string>('exportBackup', password); }
  importBackup(encryptedJson: string, password: string) { return this.call<WalletMetadata>('importBackup', encryptedJson, password); }
  revealMnemonic(password: string) { return this.call<string>('revealMnemonic', password); }
  changePassword(currentPassword: string, newPassword: string) { return this.call<void>('changePassword', currentPassword, newPassword); }
  reset(password: string) { return this.call<void>('reset', password); }
}
