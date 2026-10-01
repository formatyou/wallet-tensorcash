import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMetadata, deriveAccount, deriveAddress } from '../../src/core/keys';
import { networkConfig } from '../../src/core/network';
import { LocalWalletEngine, AUTO_LOCK_MS } from '../../src/wallet/engine';
import { createDisplayCache, decryptDisplayCache, encryptDisplayCache, MAX_DISPLAY_CACHE_BYTES, validateDisplayCache } from '../../src/wallet/display-cache';
import type { DisplayCacheInput } from '../../src/wallet/display-cache';
import type { VaultStorage } from '../../src/wallet/storage';
import { encryptVault, parseEnvelope, type KdfSettings } from '../../src/wallet/vault';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'wallet cache password 2026';
const NEW_PASSWORD = 'changed cache password 2026';
const KDF: KdfSettings = { name: 'scrypt', N: 32768, r: 8, p: 1, dkLen: 32 };
class MemoryStorage implements VaultStorage {
  value: string | null = null; cache: string | null = null;
  async read() { return this.value; }
  async write(value: string) { this.value = value; this.cache = null; }
  async clear() { this.value = this.cache = null; }
  async compareAndSwap(expected: string | null, replacement: string | null, displayCache?: string | null) {
    if (this.value !== expected) throw new Error('Wallet changed in another tab');
    this.value = replacement; this.cache = replacement ? displayCache ?? null : null;
  }
  async readDisplayCache(expected: string) { return expected === this.value ? this.cache : null; }
  async writeDisplayCache(expected: string, value: string | null) {
    if (this.value !== expected) throw new Error('Wallet changed in another tab');
    this.cache = value;
  }
}
const engines: LocalWalletEngine[] = [];
afterEach(async () => { await Promise.all(engines.map(engine => engine.lock())); engines.length = 0; vi.useRealTimers(); });
function fixture() {
  const account = deriveAccount(MNEMONIC, 'regtest');
  const metadata = createMetadata(account, 'regtest', true);
  const receive = deriveAddress(account, 'regtest', 0, 0); const change = deriveAddress(account, 'regtest', 1, 0);
  account.wipePrivateData(); const observedAt = new Date().toISOString();
  const input: DisplayCacheInput = { receive, change, ownedAddresses: [receive, change], snapshot: {
    network: { network: 'regtest', chain: 'regtest', genesisHash: networkConfig('regtest').genesisHash,
      height: 105, indexedHeight: 105, tipHash: 'aa'.repeat(32), ready: true, observedAt, explorerUrl: null, minConfirmations: 3, coinbaseMaturity: 100 },
    addresses: [{ address: receive.address, used: true }, { address: change.address, used: false }],
    utxos: [{ txid: 'bb'.repeat(32), vout: 0, address: receive.address, scriptHex: receive.scriptHex,
      amountUnits: '1000000', confirmations: 5, blockHeight: 101, coinbase: false, classification: 'native', verified: true, rawParent: 'deadbeef' }],
    history: [{ txid: 'bb'.repeat(32), deltaUnits: '1000000', feeUnits: null, status: 'confirmed', confirmations: 5, blockHeight: 101, timestamp: 1790000000 }],
    complete: true, warnings: [], observedAt, mempoolFingerprint: 'cc'.repeat(32), spentOutpoints: [{ txid: 'dd'.repeat(32), vout: 0, spentByTxid: 'bb'.repeat(32) }],
  } };
  return { metadata, input };
}
async function savedEngine(storage = new MemoryStorage()) {
  const e = new LocalWalletEngine(storage, KDF); engines.push(e);
  const metadata = await e.restore(MNEMONIC, PASSWORD, 'regtest');
  const input = fixture().input; await e.saveDisplayCache(input);
  return { e, storage, metadata, input };
}
describe('encrypted last verified wallet display', () => {
  it('retains amounts and activity without any spendable input or private material', async () => {
    const { metadata, input } = fixture(); const sealed = await encryptVault(MNEMONIC, metadata, PASSWORD, KDF);
    const json = await encryptDisplayCache(input, metadata, sealed.key, sealed.envelope.salt);
    for (const publicValue of ['1000000', input.receive.address, input.snapshot.history[0].txid, 'deadbeef', MNEMONIC, PASSWORD]) expect(json).not.toContain(publicValue);
    const cache = await decryptDisplayCache(json, metadata, sealed.key, sealed.envelope.salt);
    expect(cache?.balances).toEqual({ spendable: '1000000', pending: '0', unsupported: '0' });
    expect(cache?.snapshot.history).toEqual(input.snapshot.history); expect(cache?.receive).toEqual(input.receive);
    expect(cache?.verifiedAt).toBe(input.snapshot.observedAt); expect(cache?.snapshot.complete).toBe(false);
    expect(cache?.snapshot.network.ready).toBe(false); expect(cache?.snapshot.utxos).toEqual([]);
    expect(cache?.snapshot).not.toHaveProperty('spentOutpoints'); expect(cache?.snapshot).not.toHaveProperty('mempoolFingerprint');
  });
  it('authenticates wallet identity, account, network and key generation and ignores corruption', async () => {
    const { metadata, input } = fixture(); const sealed = await encryptVault(MNEMONIC, metadata, PASSWORD, KDF);
    const json = await encryptDisplayCache(input, metadata, sealed.key, sealed.envelope.salt);
    const foreign = deriveAccount('legal winner thank year wave sausage worth useful legal winner thank yellow', 'regtest');
    const foreignMetadata = createMetadata(foreign, 'regtest', true); foreign.wipePrivateData();
    for (const changed of [{ ...metadata, id: crypto.randomUUID() }, { ...metadata, network: 'mainnet' as const },
      { ...metadata, accountXpub: foreignMetadata.accountXpub }]) expect(await decryptDisplayCache(json, changed, sealed.key, sealed.envelope.salt)).toBeNull();
    expect(await decryptDisplayCache(json, metadata, sealed.key, '00'.repeat(16))).toBeNull();
    const parsed = JSON.parse(json); parsed.ciphertext = '00' + parsed.ciphertext.slice(2);
    expect(await decryptDisplayCache(JSON.stringify(parsed), metadata, sealed.key, sealed.envelope.salt)).toBeNull();
    expect(await decryptDisplayCache('invalid JSON', metadata, sealed.key, sealed.envelope.salt)).toBeNull();
    expect(await decryptDisplayCache('x'.repeat(MAX_DISPLAY_CACHE_BYTES * 3), metadata, sealed.key, sealed.envelope.salt)).toBeNull();
  });
  it('rejects incomplete snapshots, invalid amounts, foreign receive addresses and future timestamps', () => {
    const { metadata, input } = fixture();
    expect(() => createDisplayCache({ ...input, snapshot: { ...input.snapshot, complete: false } }, metadata)).toThrow(/complete/);
    expect(() => createDisplayCache({ ...input, snapshot: { ...input.snapshot, network: { ...input.snapshot.network, ready: false } } }, metadata)).toThrow(/complete/);
    const cache = createDisplayCache(input, metadata);
    expect(() => validateDisplayCache({ ...cache, balances: { ...cache.balances, spendable: '-1' } }, metadata)).toThrow();
    expect(() => validateDisplayCache({ ...cache, receive: { ...cache.receive, address: cache.change.address } }, metadata)).toThrow(/selected address/);
    expect(() => validateDisplayCache({ ...cache, ownedAddresses: [cache.receive, { ...cache.change, index: 1 }] }, metadata)).toThrow(/owned address/);
    expect(() => validateDisplayCache({ ...cache, snapshot: { ...cache.snapshot, utxos: input.snapshot.utxos } }, metadata)).toThrow();
    expect(() => createDisplayCache({ ...input, snapshot: { ...input.snapshot, observedAt: new Date(Date.now() + 120_000).toISOString() } }, metadata)).toThrow(/checkpoint/);
  });
  it('bounds cached history and records explicitly when earlier activity was omitted', () => {
    const { metadata, input } = fixture();
    input.snapshot.history = Array.from({ length: 250 }, (_, index) => ({ ...input.snapshot.history[0], txid: index.toString(16).padStart(64, '0') }));
    const cache = createDisplayCache(input, metadata);
    expect(cache.snapshot.history).toHaveLength(200); expect(cache.historyTruncated).toBe(true);
  });
  it('survives lock and a new engine instance, but decrypts only while unlocked', async () => {
    const { e, storage } = await savedEngine();
    await e.lock(); await expect(e.loadDisplayCache()).rejects.toThrow(/Unlock/);
    const reloaded = new LocalWalletEngine(storage, KDF); engines.push(reloaded);
    await reloaded.unlock(PASSWORD); expect((await reloaded.loadDisplayCache())?.balances.spendable).toBe('1000000');
    expect(await reloaded.exportBackup(PASSWORD)).not.toContain('display-cache');
  });
  it('atomically reencrypts the display when changing password without changing the seed backup format', async () => {
    const { e, storage } = await savedEngine(); const original = storage.cache;
    await e.changePassword(PASSWORD, NEW_PASSWORD);
    expect(storage.cache).not.toBe(original); expect(parseEnvelope(storage.value!).version).toBe(1);
    await e.lock(); await expect(e.unlock(PASSWORD)).rejects.toThrow(); await e.unlock(NEW_PASSWORD);
    expect((await e.loadDisplayCache())?.balances.spendable).toBe('1000000');
  });
  it('clears the display on reset, seed replacement and clean backup import', async () => {
    const { e, storage } = await savedEngine(); const backup = await e.exportBackup(PASSWORD);
    await e.reset(PASSWORD); expect(storage.cache).toBeNull();
    await e.importBackup(backup, PASSWORD); expect(await e.loadDisplayCache()).toBeNull();
    await e.reset(PASSWORD); await e.restore('legal winner thank year wave sausage worth useful legal winner thank yellow', PASSWORD, 'regtest');
    expect(await e.loadDisplayCache()).toBeNull();
  });
  it('does not let optional corrupted cache prevent unlocking or keep an old cache across rekey', async () => {
    const { e, storage } = await savedEngine(); storage.cache = '{broken';
    await e.lock(); await e.unlock(PASSWORD); expect(await e.loadDisplayCache()).toBeNull();
    await e.changePassword(PASSWORD, NEW_PASSWORD); expect(storage.cache).toBeNull();
  });
  it('rejects old-tab cache writes after another tab changes or replaces the vault', async () => {
    const { e, storage, input } = await savedEngine();
    const second = new LocalWalletEngine(storage, KDF); engines.push(second); await second.unlock(PASSWORD);
    await e.changePassword(PASSWORD, NEW_PASSWORD); const currentCache = storage.cache;
    await expect(second.saveDisplayCache(input)).rejects.toThrow(/another tab/); expect(storage.cache).toBe(currentCache);
    await expect(second.loadDisplayCache()).rejects.toThrow(/Unlock/);
  });
  it('never extends inactivity time through cache polling, and checks expiry with suspended timers', async () => {
    const { e, input } = await savedEngine(); vi.useFakeTimers(); await e.recordActivity();
    vi.advanceTimersByTime(AUTO_LOCK_MS - 1000);
    await e.loadDisplayCache(); await e.saveDisplayCache(input);
    vi.setSystemTime(Date.now() + 1001);
    await expect(e.loadDisplayCache()).rejects.toThrow(/Unlock/); await expect(e.saveDisplayCache(input)).rejects.toThrow(/Unlock/);
  });
  it('discards old-session cache data when locking during an asynchronous read', async () => {
    const { e, storage } = await savedEngine();
    let entered!: () => void; const reading = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    const originalRead = storage.readDisplayCache.bind(storage);
    storage.readDisplayCache = async expected => { entered(); await held; return originalRead(expected); };
    const loading = e.loadDisplayCache(); await reading; await e.lock(); release();
    expect(await loading).toBeNull();
  });
});
