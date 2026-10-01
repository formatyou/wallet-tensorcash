import { HDKey } from '@scure/bip32';
import type { WalletEngine, WalletMetadata, WalletNetwork, SpendRequest, TransferPlan, SignedTransfer, AddressRecord } from '../shared/types';
import { accountFromMetadata, createMetadata, deriveAccount, deriveAddress, newMnemonic, normalizeMnemonic } from '../core/keys';
import { prepareNativeTransfer, signNativeTransfer, type PreparedTransfer } from '../core/transactions';
import { networkConfig } from '../core/network';
import type { VaultStorage } from './storage';
import { decryptVault, encryptVault, parseEnvelope, sealWithKey, validatePassword, type UnsealedVault, type KdfSettings, DEFAULT_KDF } from './vault';
import { decryptDisplayCache, encryptDisplayCache, type DisplayCacheInput, type WalletDisplayCache } from './display-cache';

export const AUTO_LOCK_MS = 5 * 60_000;
export class LocalWalletEngine implements WalletEngine {
  private session: (UnsealedVault & { account: HDKey }) | null = null;
  private plans = new Map<string, PreparedTransfer>(); private timer: ReturnType<typeof setTimeout> | undefined;
  private expiresAt = 0;
  constructor(private storage: VaultStorage, private settings: KdfSettings = DEFAULT_KDF) {}
  private touch() { clearTimeout(this.timer); if (this.session) { this.expiresAt = Date.now() + AUTO_LOCK_MS; this.timer = setTimeout(() => { void this.lock(); }, AUTO_LOCK_MS); } }
  private active() { if (this.session && Date.now() >= this.expiresAt) void this.lock(); if (!this.session) throw new Error('Unlock the wallet first'); this.touch(); return this.session; }
  private async live(touch = true) { if (this.session && Date.now() >= this.expiresAt) await this.lock(); const session = touch ? this.active() : this.session; if (!session) throw new Error('Unlock the wallet first'); if (await this.storage.read() !== JSON.stringify(session.envelope) || this.session !== session) { await this.lock(); throw new Error('Wallet changed in another tab; unlock again'); } return session; }
  private async stored() { const json = await this.storage.read(); if (!json) throw new Error('No wallet exists on this device'); return json; }
  private async empty() { if (await this.storage.read()) throw new Error('A wallet already exists; back it up and reset it before replacing'); }
  private activate(value: UnsealedVault) { this.session?.account.wipePrivateData(); this.plans.clear(); this.session = { ...value, account: deriveAccount(value.mnemonic, value.metadata.network) }; this.touch(); }
  async getMetadata(): Promise<WalletMetadata | null> { if (this.session) return structuredClone((await this.live(false)).metadata); const stored = await this.storage.read(); return stored ? structuredClone(parseEnvelope(stored).metadata) : null; }
  async create(password: string, network: WalletNetwork) {
    await this.empty(); validatePassword(password); networkConfig(network); const mnemonic = newMnemonic(); const account = deriveAccount(mnemonic, network);
    const metadata = createMetadata(account, network); account.wipePrivateData(); const sealed = await encryptVault(mnemonic, metadata, password, this.settings);
    await this.storage.compareAndSwap(null, JSON.stringify(sealed.envelope)); this.activate(sealed); return { metadata: structuredClone(metadata), mnemonic };
  }
  async restore(mnemonic: string, password: string, network: WalletNetwork) {
    await this.empty(); const normalized = normalizeMnemonic(mnemonic); validatePassword(password); networkConfig(network); const account = deriveAccount(normalized, network);
    const metadata = createMetadata(account, network, true); account.wipePrivateData(); const sealed = await encryptVault(normalized, metadata, password, this.settings);
    await this.storage.compareAndSwap(null, JSON.stringify(sealed.envelope)); this.activate(sealed); return structuredClone(metadata);
  }
  async unlock(password: string) { await this.lock(); const sealed = await decryptVault(await this.stored(), password); this.activate(sealed); return structuredClone(sealed.metadata); }
  async lock() { clearTimeout(this.timer); this.timer = undefined; this.expiresAt = 0; this.session?.account.wipePrivateData(); this.session = null; this.plans.clear(); }
  async recordActivity() { this.active(); }
  async acknowledgeBackup() {
    const session = await this.live(); const metadata = { ...session.metadata, backupConfirmed: true }; const envelope = await sealWithKey(session.mnemonic, metadata, session.key, session.envelope);
    const cache = await this.storage.readDisplayCache?.(JSON.stringify(session.envelope));
    await this.storage.compareAndSwap(JSON.stringify(session.envelope), JSON.stringify(envelope), cache); session.metadata = metadata; session.envelope = envelope; return structuredClone(metadata);
  }
  async loadDisplayCache(): Promise<WalletDisplayCache | null> {
    const session = await this.live(false);
    const json = await this.storage.readDisplayCache?.(JSON.stringify(session.envelope));
    if (!json) return null;
    const cache = await decryptDisplayCache(json, session.metadata, session.key, session.envelope.salt);
    // Locking/replacing the session during decryption must not expose its view.
    if (this.session !== session || Date.now() >= this.expiresAt) return null;
    await this.live(false); return cache;
  }
  async saveDisplayCache(input: DisplayCacheInput | null): Promise<void> {
    const session = await this.live(false);
    if (!this.storage.writeDisplayCache) return;
    const json = input ? await encryptDisplayCache(input, session.metadata, session.key, session.envelope.salt) : null;
    if (this.session !== session || Date.now() >= this.expiresAt) return;
    await this.storage.writeDisplayCache(JSON.stringify(session.envelope), json);
  }
  async getAddresses(branch: 0 | 1, start: number, count: number): Promise<AddressRecord[]> {
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(count) || count < 1 || count > 100 || start + count > 100_001) throw new Error('Address range is outside limits');
    const metadata = await this.getMetadata(); if (!metadata) throw new Error('No wallet exists on this device'); const account = accountFromMetadata(metadata);
    try { return Array.from({ length: count }, (_, i) => deriveAddress(account, metadata.network, branch, start + i)); } finally { account.wipePrivateData(); }
  }
  async prepareTransfer(request: SpendRequest): Promise<TransferPlan> {
    const session = await this.live(); for (const [id, value] of this.plans) if (Date.now() > value.expiresAt) this.plans.delete(id);
    if (this.plans.size >= 8) this.plans.delete(this.plans.keys().next().value!);
    const prepared = prepareNativeTransfer(structuredClone(request), session.account, session.metadata); this.plans.set(prepared.plan.id, prepared); return structuredClone(prepared.plan);
  }
  async signTransfer(planId: string): Promise<SignedTransfer> {
    const session = await this.live(); const prepared = this.plans.get(planId); if (!prepared) throw new Error('Reviewed transfer is missing or expired'); this.plans.delete(planId);
    if (!session.metadata.backupConfirmed) throw new Error('Confirm your backup before sending'); return signNativeTransfer(prepared, session.account);
  }
  async exportBackup(password: string) { const json = await this.stored(); await decryptVault(json, password); return json; }
  async importBackup(encryptedJson: string, password: string) {
    await this.empty(); const sealed = await decryptVault(encryptedJson, password); const metadata = { ...sealed.metadata, backupConfirmed: true };
    const envelope = await sealWithKey(sealed.mnemonic, metadata, sealed.key, sealed.envelope); await this.storage.compareAndSwap(null, JSON.stringify(envelope)); this.activate({ ...sealed, envelope, metadata }); return structuredClone(metadata);
  }
  async revealMnemonic(password: string) { const sealed = await decryptVault(await this.stored(), password); return sealed.mnemonic; }
  async changePassword(currentPassword: string, newPassword: string) {
    const previous = await this.stored(); const value = await decryptVault(previous, currentPassword); validatePassword(newPassword); const sealed = await encryptVault(value.mnemonic, value.metadata, newPassword, this.settings);
    const json = await this.storage.readDisplayCache?.(previous);
    const cache = json ? await decryptDisplayCache(json, value.metadata, value.key, value.envelope.salt) : null;
    const rekeyed = cache ? await encryptDisplayCache(cache, sealed.metadata, sealed.key, sealed.envelope.salt) : null;
    await this.storage.compareAndSwap(previous, JSON.stringify(sealed.envelope), rekeyed); if (this.session) this.activate(sealed);
  }
  async reset(password: string) { const previous = await this.stored(); await decryptVault(previous, password); await this.storage.compareAndSwap(previous, null); await this.lock(); }
}
