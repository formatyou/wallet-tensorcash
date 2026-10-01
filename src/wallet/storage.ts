export interface VaultStorage {
  read(): Promise<string | null>; write(envelope: string): Promise<void>; clear(): Promise<void>;
  compareAndSwap(expected: string | null, replacement: string | null, displayCache?: string | null): Promise<void>;
  readDisplayCache?(expectedVault: string): Promise<string | null>;
  writeDisplayCache?(expectedVault: string, displayCache: string | null): Promise<void>;
}
const DB_NAME = 'tensorcash-wallet-v1'; const STORE_NAME = 'vault'; const KEY = 'active'; const DISPLAY_KEY = 'display-cache';
export class IndexedDbVaultStorage implements VaultStorage {
  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => { const request = indexedDB.open(DB_NAME, 1); request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error('Wallet storage could not be opened')); request.onblocked = () => reject(new Error('Wallet storage is blocked by another tab')); });
  }
  private async transact<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    try { return await new Promise<T>((resolve, reject) => { const tx = db.transaction(STORE_NAME, mode); const request = action(tx.objectStore(STORE_NAME)); let value: T; request.onsuccess = () => { value = request.result; }; tx.oncomplete = () => resolve(value); tx.onerror = () => reject(new Error('Wallet storage operation failed')); tx.onabort = () => reject(new Error('Wallet storage operation aborted')); }); } finally { db.close(); }
  }
  async read(): Promise<string | null> { const result = await this.transact('readonly', store => store.get(KEY)); if (result === undefined) return null; if (typeof result !== 'string') throw new Error('Invalid wallet storage'); return result; }
  async write(envelope: string): Promise<void> { await this.transact('readwrite', store => { store.delete(DISPLAY_KEY); return store.put(envelope, KEY); }); }
  async clear(): Promise<void> { await this.transact('readwrite', store => { store.delete(DISPLAY_KEY); return store.delete(KEY); }); }
  async readDisplayCache(expectedVault: string): Promise<string | null> {
    const db = await this.open();
    try { return await new Promise<string | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly'); const store = tx.objectStore(STORE_NAME);
      const vault = store.get(KEY); const display = store.get(DISPLAY_KEY); let result: string | null = null;
      display.onsuccess = () => { if (vault.result === expectedVault && typeof display.result === 'string') result = display.result; };
      tx.oncomplete = () => resolve(result); tx.onerror = () => reject(new Error('Wallet display storage operation failed'));
      tx.onabort = () => reject(new Error('Wallet display storage operation aborted'));
    }); } finally { db.close(); }
  }
  async writeDisplayCache(expectedVault: string, displayCache: string | null): Promise<void> {
    const db = await this.open();
    try { await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite'); const store = tx.objectStore(STORE_NAME); const request = store.get(KEY); let conflict = false;
      request.onsuccess = () => {
        if (request.result !== expectedVault) { conflict = true; tx.abort(); return; }
        if (displayCache === null) store.delete(DISPLAY_KEY); else store.put(displayCache, DISPLAY_KEY);
      };
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(new Error(conflict ? 'Wallet changed in another tab; reload before continuing' : 'Wallet display storage operation aborted'));
      tx.onerror = () => reject(new Error('Wallet display storage operation failed'));
    }); } finally { db.close(); }
  }
  async compareAndSwap(expected: string | null, replacement: string | null, displayCache?: string | null): Promise<void> {
    const db = await this.open();
    try { await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite'); const store = tx.objectStore(STORE_NAME); const request = store.get(KEY); let conflict = false;
      request.onsuccess = () => {
        const current = request.result === undefined ? null : request.result;
        if (current !== expected) { conflict = true; tx.abort(); return; }
        if (replacement === null) store.delete(KEY); else store.put(replacement, KEY);
        // Cache invalidation or rekeying commits together with the seed vault.
        if (replacement === null || displayCache == null) store.delete(DISPLAY_KEY); else store.put(displayCache, DISPLAY_KEY);
      };
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(new Error(conflict ? 'Wallet changed in another tab; reload before continuing' : 'Wallet storage operation aborted')); tx.onerror = () => reject(new Error('Wallet storage operation failed'));
    }); } finally { db.close(); }
  }
}
