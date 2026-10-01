import { scryptAsync } from '@noble/hashes/scrypt.js';
import { hex } from '@scure/base';
import type { WalletMetadata } from '../shared/types';
import { ACCOUNT_PATH, networkConfig } from '../core/network';
import { accountFromMetadata, deriveAccount, normalizeMnemonic } from '../core/keys';

export interface KdfSettings { name: 'scrypt'; N: number; r: 8; p: 1; dkLen: 32; }
export interface VaultEnvelope { format: 'tensorcash-wallet'; version: 1; metadata: WalletMetadata; kdf: KdfSettings; salt: string; iv: string; ciphertext: string; }
export interface UnsealedVault { mnemonic: string; metadata: WalletMetadata; key: CryptoKey; envelope: VaultEnvelope; }
export const DEFAULT_KDF: KdfSettings = { name: 'scrypt', N: 131072, r: 8, p: 1, dkLen: 32 };
const encoder = new TextEncoder(); const decoder = new TextDecoder('utf-8', { fatal: true });
function exactKeys(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== keys.sort().join(',')) throw new Error('Invalid backup schema');
}
export function validateMetadata(value: unknown): WalletMetadata {
  exactKeys(value, ['version', 'id', 'network', 'createdAt', 'accountPath', 'accountXpub', 'fingerprint', 'backupConfirmed']);
  if (value.version !== 1 || typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/.test(value.id) || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || value.accountPath !== ACCOUNT_PATH || typeof value.accountXpub !== 'string' || value.accountXpub.length > 128 || typeof value.fingerprint !== 'string' || !/^[a-f0-9]{8}$/.test(value.fingerprint) || typeof value.backupConfirmed !== 'boolean') throw new Error('Invalid wallet metadata');
  networkConfig(value.network as WalletMetadata['network']);
  const metadata: WalletMetadata = { version: 1, id: value.id, network: value.network as WalletMetadata['network'], createdAt: value.createdAt, accountPath: ACCOUNT_PATH, accountXpub: value.accountXpub, fingerprint: value.fingerprint, backupConfirmed: value.backupConfirmed };
  accountFromMetadata(metadata).wipePrivateData(); return metadata;
}
export function validateKdf(value: unknown): KdfSettings {
  exactKeys(value, ['name', 'N', 'r', 'p', 'dkLen']);
  if (value.name !== 'scrypt' || typeof value.N !== 'number' || !Number.isSafeInteger(value.N) || value.N < 32768 || value.N > 262144 || (value.N & (value.N - 1)) !== 0 || value.r !== 8 || value.p !== 1 || value.dkLen !== 32) throw new Error('Unsafe or unsupported backup KDF parameters');
  return { name: 'scrypt', N: value.N, r: 8, p: 1, dkLen: 32 };
}
export function parseEnvelope(json: string): VaultEnvelope {
  if (typeof json !== 'string' || json.length > 8192) throw new Error('Backup exceeds size limit');
  let value: unknown; try { value = JSON.parse(json); } catch { throw new Error('Invalid backup JSON'); }
  exactKeys(value, ['format', 'version', 'metadata', 'kdf', 'salt', 'iv', 'ciphertext']);
  if (value.format !== 'tensorcash-wallet' || value.version !== 1 || typeof value.salt !== 'string' || !/^[a-f0-9]{32}$/.test(value.salt) || typeof value.iv !== 'string' || !/^[a-f0-9]{24}$/.test(value.iv) || typeof value.ciphertext !== 'string' || value.ciphertext.length < 32 || value.ciphertext.length > 2048 || value.ciphertext.length % 2 || !/^[a-f0-9]+$/.test(value.ciphertext)) throw new Error('Invalid backup encryption format');
  return { format: 'tensorcash-wallet', version: 1, metadata: validateMetadata(value.metadata), kdf: validateKdf(value.kdf), salt: value.salt, iv: value.iv, ciphertext: value.ciphertext };
}
function aad(envelope: Omit<VaultEnvelope, 'ciphertext'>): Uint8Array {
  return encoder.encode(JSON.stringify({ format: envelope.format, version: envelope.version, metadata: validateMetadata(envelope.metadata), kdf: validateKdf(envelope.kdf), salt: envelope.salt, iv: envelope.iv }));
}
export function validatePassword(password: string): void {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw new Error('Use a password between 12 and 256 characters');
}
async function deriveKey(password: string, salt: string, settings: KdfSettings): Promise<CryptoKey> {
  validatePassword(password); const kdf = validateKdf(settings);
  const bytes = await scryptAsync(password, hex.decode(salt), { ...kdf, maxmem: 300 * 1024 * 1024, asyncTick: 5 });
  try { return await crypto.subtle.importKey('raw', Uint8Array.from(bytes), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']); } finally { bytes.fill(0); }
}
function validateSecrets(mnemonic: string, metadata: WalletMetadata): string {
  const normalized = normalizeMnemonic(mnemonic); const account = deriveAccount(normalized, metadata.network);
  try { if (metadata.accountXpub !== account.publicExtendedKey || metadata.fingerprint !== account.fingerprint.toString(16).padStart(8, '0')) throw new Error('Backup metadata does not match its seed'); } finally { account.wipePrivateData(); }
  return normalized;
}
export async function sealWithKey(mnemonic: string, metadata: WalletMetadata, key: CryptoKey, previous: Pick<VaultEnvelope, 'kdf' | 'salt'>): Promise<VaultEnvelope> {
  const normalized = validateSecrets(mnemonic, validateMetadata(metadata));
  const header = { format: 'tensorcash-wallet' as const, version: 1 as const, metadata: validateMetadata(metadata), kdf: validateKdf(previous.kdf), salt: previous.salt, iv: hex.encode(crypto.getRandomValues(new Uint8Array(12))) };
  const plaintext = encoder.encode(JSON.stringify({ version: 1, mnemonic: normalized, bip39Passphrase: '', accountPath: ACCOUNT_PATH, network: metadata.network }));
  try {
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: Uint8Array.from(hex.decode(header.iv)), additionalData: Uint8Array.from(aad(header)), tagLength: 128 }, key, Uint8Array.from(plaintext));
    return { ...header, ciphertext: hex.encode(new Uint8Array(encrypted)) };
  } finally { plaintext.fill(0); }
}
export async function encryptVault(mnemonic: string, metadata: WalletMetadata, password: string, settings: KdfSettings = DEFAULT_KDF): Promise<UnsealedVault> {
  validatePassword(password); const kdf = validateKdf(settings); const salt = hex.encode(crypto.getRandomValues(new Uint8Array(16))); const key = await deriveKey(password, salt, kdf);
  const envelope = await sealWithKey(mnemonic, metadata, key, { kdf, salt });
  return { mnemonic: normalizeMnemonic(mnemonic), metadata: envelope.metadata, key, envelope };
}
export async function decryptVault(json: string, password: string): Promise<UnsealedVault> {
  const envelope = parseEnvelope(json); const key = await deriveKey(password, envelope.salt, envelope.kdf);
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Uint8Array.from(hex.decode(envelope.iv)), additionalData: Uint8Array.from(aad(envelope)), tagLength: 128 }, key, Uint8Array.from(hex.decode(envelope.ciphertext))));
    const payload: unknown = JSON.parse(decoder.decode(plaintext)); exactKeys(payload, ['version', 'mnemonic', 'bip39Passphrase', 'accountPath', 'network']);
    if (payload.version !== 1 || typeof payload.mnemonic !== 'string' || payload.bip39Passphrase !== '' || payload.accountPath !== ACCOUNT_PATH || payload.network !== envelope.metadata.network) throw new Error('Unsupported secret format');
    const mnemonic = validateSecrets(payload.mnemonic, envelope.metadata);
    return { mnemonic, metadata: envelope.metadata, key, envelope };
  } catch { throw new Error('Password is incorrect or backup authentication failed'); } finally { plaintext?.fill(0); }
}
