import { describe, it, expect, afterEach, vi } from 'vitest';
import { createMetadata, deriveAccount } from '../../src/core/keys';
import { encryptVault, decryptVault, parseEnvelope, type KdfSettings } from '../../src/wallet/vault';
import { LocalWalletEngine, AUTO_LOCK_MS } from '../../src/wallet/engine';
import type { VaultStorage } from '../../src/wallet/storage';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'correct horse battery staple';
const KDF: KdfSettings = { name: 'scrypt', N: 32768, r: 8, p: 1, dkLen: 32 };
class MemoryStorage implements VaultStorage { value: string | null = null; async read() { return this.value; } async write(value: string) { this.value = value; } async clear() { this.value = null; } async compareAndSwap(expected: string | null, replacement: string | null) { if (this.value !== expected) throw new Error('Wallet changed in another tab'); this.value = replacement; } }
const engines: LocalWalletEngine[] = []; afterEach(async () => { await Promise.all(engines.map(engine => engine.lock())); engines.length = 0; vi.useRealTimers(); });
const engine = (storage = new MemoryStorage()) => { const value = new LocalWalletEngine(storage, KDF); engines.push(value); return { engine: value, storage }; };
function metadata() { const account = deriveAccount(MNEMONIC, 'regtest'); const result = createMetadata(account, 'regtest', true); account.wipePrivateData(); return result; }
describe('authenticated encrypted wallet vault', () => {
  it('round-trips the seed while persisting only ciphertext and public metadata', async () => {
    const sealed = await encryptVault(MNEMONIC, metadata(), PASSWORD, KDF); const json = JSON.stringify(sealed.envelope);
    expect(json).not.toContain('abandon'); expect(json).not.toContain(PASSWORD); expect((await decryptVault(json, PASSWORD)).mnemonic).toBe(MNEMONIC);
    expect(sealed.key.extractable).toBe(false); expect(sealed.envelope.iv).toHaveLength(24); expect(sealed.envelope.salt).toHaveLength(32);
  });
  it('rejects wrong password, tampered ciphertext and public metadata', async () => {
    const { envelope } = await encryptVault(MNEMONIC, metadata(), PASSWORD, KDF);
    await expect(decryptVault(JSON.stringify(envelope), 'different password')).rejects.toThrow(/authentication/);
    for (const mutate of [(v: typeof envelope) => { v.ciphertext = (v.ciphertext[0] === '0' ? '1' : '0') + v.ciphertext.slice(1); }, (v: typeof envelope) => { v.metadata.network = 'mainnet'; }, (v: typeof envelope) => { v.metadata.backupConfirmed = false; }, (v: typeof envelope) => { v.iv = '00'.repeat(12); }]) { const changed = structuredClone(envelope); mutate(changed); await expect(decryptVault(JSON.stringify(changed), PASSWORD)).rejects.toThrow(); }
  });
  it('never treats a private extended key or a mismatched public account as public metadata', async () => {
    const account = deriveAccount(MNEMONIC, 'regtest'); const { envelope } = await encryptVault(MNEMONIC, metadata(), PASSWORD, KDF);
    expect(() => parseEnvelope(JSON.stringify({ ...envelope, metadata: { ...envelope.metadata, accountXpub: account.privateExtendedKey } }))).toThrow(/public account/);
    expect(() => parseEnvelope(JSON.stringify({ ...envelope, metadata: { ...envelope.metadata, fingerprint: '00000000' } }))).toThrow(/public account/); account.wipePrivateData();
  });
  it('rejects unbounded KDF, weak passwords and malformed schema before decrypting', async () => {
    const { envelope } = await encryptVault(MNEMONIC, metadata(), PASSWORD, KDF);
    for (const N of [1, 32769, 524288, 2 ** 40]) expect(() => parseEnvelope(JSON.stringify({ ...envelope, kdf: { ...KDF, N } }))).toThrow(/KDF/);
    expect(() => parseEnvelope(JSON.stringify({ ...envelope, surprise: true }))).toThrow(/schema/);
    expect(() => parseEnvelope('x'.repeat(9000))).toThrow(/limit/); await expect(encryptVault(MNEMONIC, metadata(), 'short', KDF)).rejects.toThrow(/password/);
  });
  it('creates 12 words, confirms backup, locks and derives public addresses while locked', async () => {
    const { engine: e, storage } = engine(); const created = await e.create(PASSWORD, 'regtest'); expect(created.mnemonic.split(' ')).toHaveLength(12); expect(created.metadata.backupConfirmed).toBe(false);
    const address = (await e.getAddresses(0, 0, 1))[0]; const before = parseEnvelope(storage.value!); await e.acknowledgeBackup(); expect((await e.getMetadata())?.backupConfirmed).toBe(true); expect(parseEnvelope(storage.value!).iv).not.toBe(before.iv);
    await e.lock(); expect((await e.getAddresses(0, 0, 1))[0]).toEqual(address); await expect(e.signTransfer('missing')).rejects.toThrow(/Unlock/); await e.unlock(PASSWORD); expect((await e.revealMnemonic(PASSWORD))).toBe(created.mnemonic);
  });
  it('restores on a clean device and imports authenticated backup', async () => {
    const { engine: first } = engine(); await first.restore(MNEMONIC, PASSWORD, 'regtest'); const addresses = await first.getAddresses(0, 0, 3); const backup = await first.exportBackup(PASSWORD);
    const { engine: second } = engine(); const imported = await second.importBackup(backup, PASSWORD); expect(imported.backupConfirmed).toBe(true); expect(await second.getAddresses(0, 0, 3)).toEqual(addresses);
    const { engine: third } = engine(); await third.restore(MNEMONIC, PASSWORD, 'regtest'); expect(await third.getAddresses(0, 0, 3)).toEqual(addresses); await expect(second.create(PASSWORD, 'regtest')).rejects.toThrow(/already exists/);
  });
  it('changes password atomically and requires authentication before deleting', async () => {
    const { engine: e, storage } = engine(); await e.restore(MNEMONIC, PASSWORD, 'regtest'); const address = await e.getAddresses(1, 2, 1); const old = storage.value;
    await expect(e.changePassword('wrong password value', 'new password phrase')).rejects.toThrow(); expect(storage.value).toBe(old);
    await e.changePassword(PASSWORD, 'new password phrase'); await e.lock(); await expect(e.unlock(PASSWORD)).rejects.toThrow(); await e.unlock('new password phrase'); expect(await e.getAddresses(1, 2, 1)).toEqual(address);
    await expect(e.reset(PASSWORD)).rejects.toThrow(); expect(await e.getMetadata()).not.toBeNull(); await e.reset('new password phrase'); expect(await e.getMetadata()).toBeNull();
  });
  it('rejects stale sessions after another tab changes the vault', async () => {
    const { engine: first, storage } = engine(); await first.restore(MNEMONIC, PASSWORD, 'regtest'); const { engine: second } = engine(storage); await second.unlock(PASSWORD);
    await first.changePassword(PASSWORD, 'new password phrase'); await expect(second.acknowledgeBackup()).rejects.toThrow(/another tab/);
    await second.unlock('new password phrase'); expect(await second.getAddresses(0, 0, 1)).toEqual(await first.getAddresses(0, 0, 1));
  });
  it('rejects replaced public receive metadata during an unlocked session', async () => {
    const { engine: e, storage } = engine(); await e.restore(MNEMONIC, PASSWORD, 'regtest');
    const envelope = parseEnvelope(storage.value!);
    const otherAccount = deriveAccount('legal winner thank year wave sausage worth useful legal winner thank yellow', 'regtest');
    const other = createMetadata(otherAccount, 'regtest', true); otherAccount.wipePrivateData();
    envelope.metadata.accountXpub = other.accountXpub; envelope.metadata.fingerprint = other.fingerprint;
    storage.value = JSON.stringify(envelope);
    await expect(e.getAddresses(0, 0, 1)).rejects.toThrow(/another tab/);
    await expect(e.signTransfer('unused')).rejects.toThrow(/Unlock/);
    await expect(e.unlock(PASSWORD)).rejects.toThrow(/authentication/);
  });
  it('automatically removes the unlocked signing session after inactivity', async () => {
    const { engine: e } = engine(); await e.restore(MNEMONIC, PASSWORD, 'regtest'); vi.useFakeTimers(); await e.acknowledgeBackup();
    vi.advanceTimersByTime(AUTO_LOCK_MS - 1000); await e.getMetadata(); await e.getAddresses(0, 0, 1);
    vi.advanceTimersByTime(1001); await expect(e.signTransfer('unused')).rejects.toThrow(/Unlock/); expect(await e.getMetadata()).not.toBeNull();
  });
  it('keeps a session active for five minutes after actual user activity but not public polling', async () => {
    const { engine: e } = engine(); await e.restore(MNEMONIC, PASSWORD, 'regtest'); vi.useFakeTimers();
    await e.recordActivity(); vi.advanceTimersByTime(AUTO_LOCK_MS - 1000);
    await e.recordActivity(); vi.advanceTimersByTime(AUTO_LOCK_MS - 1000);
    // A still-live session reaches plan lookup; locked sessions reject earlier.
    await expect(e.signTransfer('unused')).rejects.toThrow(/Reviewed transfer/);
    vi.advanceTimersByTime(AUTO_LOCK_MS - 1000); await e.getAddresses(0, 0, 1);
    vi.advanceTimersByTime(1001); await expect(e.recordActivity()).rejects.toThrow(/Unlock/);
  });
  it('does not revive expired signing keys when background timers were suspended', async () => {
    const { engine: e } = engine(); await e.restore(MNEMONIC, PASSWORD, 'regtest'); vi.useFakeTimers();
    await e.recordActivity(); vi.setSystemTime(Date.now() + AUTO_LOCK_MS + 1);
    await expect(e.recordActivity()).rejects.toThrow(/Unlock/);
    await expect(e.signTransfer('unused')).rejects.toThrow(/Unlock/);
    expect(await e.getMetadata()).not.toBeNull();
  });
});
