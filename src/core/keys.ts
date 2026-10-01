import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync, validateMnemonic, generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { p2wpkh } from '@scure/btc-signer';
import { hex } from '@scure/base';
import type { AddressRecord, WalletMetadata, WalletNetwork } from '../shared/types';
import { ACCOUNT_PATH, networkConfig } from './network';
export { ACCOUNT_PATH } from './network';
const englishWords = new Set(wordlist);
export function normalizeMnemonic(value: string): string {
  if (typeof value !== 'string' || value.length > 256) throw new Error('The recovery phrase is too long. Enter only your 12 English recovery words.');
  const mnemonic = value.normalize('NFKD').trim().toLowerCase().split(/\s+/).join(' ');
  const words = mnemonic ? mnemonic.split(' ') : [];
  if (words.length !== 12) throw new Error(`Enter exactly 12 recovery words. You entered ${words.length}.`);
  const unknown = words.findIndex(word => !englishWords.has(word));
  if (unknown !== -1) throw new Error(`Recovery word ${unknown + 1} is not in the English word list. Check its spelling.`);
  if (!validateMnemonic(mnemonic, wordlist)) throw new Error('The recovery phrase checksum is invalid. Check the words and their order against your backup.');
  return mnemonic;
}
export function newMnemonic(): string { return generateMnemonic(wordlist, 128); }
export function deriveAccount(mnemonic: string, network: WalletNetwork): HDKey {
  const seed = mnemonicToSeedSync(normalizeMnemonic(mnemonic), '');
  const root = HDKey.fromMasterSeed(seed, networkConfig(network).bip32); seed.fill(0);
  try { return root.derive(ACCOUNT_PATH); } finally { root.wipePrivateData(); }
}
export function accountFromMetadata(metadata: WalletMetadata): HDKey {
  if (metadata.accountPath !== ACCOUNT_PATH || metadata.version !== 1) throw new Error('Unsupported wallet derivation scheme');
  const account = HDKey.fromExtendedKey(metadata.accountXpub, networkConfig(metadata.network).bip32);
  if (account.privateKey || account.depth !== 3 || account.index !== 0x80000000 || account.fingerprint.toString(16).padStart(8, '0') !== metadata.fingerprint) { account.wipePrivateData(); throw new Error('Invalid public account metadata'); }
  return account;
}
export function deriveAddress(account: HDKey, network: WalletNetwork, branch: 0 | 1, index: number): AddressRecord {
  if ((branch !== 0 && branch !== 1) || !Number.isSafeInteger(index) || index < 0 || index > 100_000) throw new Error('Address derivation is outside bounds');
  const branchKey = account.deriveChild(branch); const child = branchKey.deriveChild(index);
  try { const payment = p2wpkh(child.publicKey!, networkConfig(network).bitcoin); return { address: payment.address!, scriptHex: hex.encode(payment.script), branch, index, path: `${ACCOUNT_PATH}/${branch}/${index}` }; } finally { child.wipePrivateData(); branchKey.wipePrivateData(); }
}
export function createMetadata(account: HDKey, network: WalletNetwork, backupConfirmed = false): WalletMetadata {
  return { version: 1, id: crypto.randomUUID(), network, createdAt: new Date().toISOString(), accountPath: ACCOUNT_PATH, accountXpub: account.publicExtendedKey, fingerprint: account.fingerprint.toString(16).padStart(8, '0'), backupConfirmed };
}
