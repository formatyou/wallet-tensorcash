import { hex } from '@scure/base';
import { z } from 'zod';
import type { AddressRecord, WalletMetadata, WalletSnapshot } from '../shared/types';
import { accountFromMetadata, deriveAddress } from '../core/keys';
import { networkConfig } from '../core/network';
import { walletBalances } from '../ui/format';

// This is a display record, never a discovery checkpoint or spending input.
export interface DisplayCacheInput {
  snapshot: WalletSnapshot; receive: AddressRecord; change: AddressRecord; ownedAddresses: AddressRecord[];
}
export interface WalletDisplayCache extends DisplayCacheInput {
  version: 1; verifiedAt: string; historyTruncated: boolean;
  balances: { spendable: string; pending: string; unsupported: string };
}
export const MAX_DISPLAY_CACHE_BYTES = 384_000;
const MAX_RECORDS = 400;
const MAX_HISTORY = 200;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const units = z.string().regex(/^(0|[1-9]\d*)$/).max(24);
const addressSchema = z.object({ address: z.string().min(1).max(100), scriptHex: z.string().regex(/^[a-f0-9]+$/).max(200),
  branch: z.union([z.literal(0), z.literal(1)]), index: z.number().int().min(0).max(199), path: z.string().max(80) }).strict();
const networkSchema = z.object({
  network: z.enum(['mainnet', 'regtest']), chain: z.string().max(20), genesisHash: hash,
  height: integer, tipHash: hash, indexedHeight: integer, ready: z.literal(false), observedAt: z.iso.datetime(),
  explorerUrl: z.string().max(2048).nullable(), minConfirmations: integer.min(1), coinbaseMaturity: integer,
  averageBlockSeconds: z.number().positive().max(86400).optional(),
  blockTimeSampleSize: z.number().int().min(1).max(144).optional(), lastBlockTime: integer.optional(),
}).strict();
const cacheSchema = z.object({
  version: z.literal(1), verifiedAt: z.iso.datetime(), historyTruncated: z.boolean(),
  balances: z.object({ spendable: units, pending: units, unsupported: units }).strict(),
  snapshot: z.object({
    network: networkSchema,
    addresses: z.array(z.object({ address: z.string().min(1).max(100), used: z.boolean() }).strict()).max(MAX_RECORDS),
    utxos: z.array(z.never()).length(0),
    history: z.array(z.object({ txid: hash, deltaUnits: z.string().regex(/^-?(0|[1-9]\d*)$/).max(25),
      feeUnits: units.nullable(), status: z.enum(['pending', 'confirmed', 'conflicted']), confirmations: integer,
      blockHeight: integer.nullable(), timestamp: integer.nullable() }).strict()).max(MAX_HISTORY),
    complete: z.literal(false), warnings: z.array(z.string().max(500)).max(100), observedAt: z.iso.datetime(),
  }).strict(),
  receive: addressSchema, change: addressSchema, ownedAddresses: z.array(addressSchema).min(2).max(MAX_RECORDS),
}).strict();
const envelopeSchema = z.object({ format: z.literal('tensorcash-display-cache'), version: z.literal(1),
  iv: z.string().regex(/^[a-f0-9]{24}$/), ciphertext: z.string().regex(/^[a-f0-9]+$/).min(32).max(MAX_DISPLAY_CACHE_BYTES * 2 + 32) }).strict();

function aad(metadata: WalletMetadata, salt: string): Uint8Array {
  return encoder.encode(JSON.stringify({ format: 'tensorcash-display-cache', version: 1,
    walletId: metadata.id, network: metadata.network, accountXpub: metadata.accountXpub, salt }));
}
export function validateDisplayCache(value: unknown, metadata: WalletMetadata): WalletDisplayCache {
  const cache = cacheSchema.parse(value);
  const config = networkConfig(metadata.network);
  if (cache.snapshot.network.network !== metadata.network || cache.snapshot.network.chain !== config.chain ||
      cache.snapshot.network.genesisHash !== config.genesisHash || cache.snapshot.network.indexedHeight !== cache.snapshot.network.height ||
      cache.verifiedAt !== cache.snapshot.observedAt || Date.parse(cache.verifiedAt) > Date.now() + 60_000)
    throw new Error('Display cache belongs to a different or invalid checkpoint');
  const account = accountFromMetadata(metadata);
  const records = new Map<string, AddressRecord>();
  try {
    for (const record of cache.ownedAddresses) {
      const expected = deriveAddress(account, metadata.network, record.branch, record.index);
      if (records.has(record.address) || record.address !== expected.address || record.scriptHex !== expected.scriptHex || record.path !== expected.path)
        throw new Error('Display cache contains an invalid owned address');
      records.set(record.address, record);
    }
  } finally { account.wipePrivateData(); }
  for (const [record, branch] of [[cache.receive, 0], [cache.change, 1]] as const) {
    const owned = records.get(record.address);
    if (record.branch !== branch || !owned || record.branch !== owned.branch || record.index !== owned.index ||
        record.scriptHex !== owned.scriptHex || record.path !== owned.path) throw new Error('Display cache contains an invalid selected address');
  }
  if (cache.snapshot.addresses.length !== records.size || new Set(cache.snapshot.addresses.map(record => record.address)).size !== records.size ||
      cache.snapshot.addresses.some(record => !records.has(record.address)) ||
      new Set(cache.snapshot.history.map(entry => entry.txid)).size !== cache.snapshot.history.length)
    throw new Error('Display cache contains an invalid address or activity range');
  return cache;
}
export function createDisplayCache(input: DisplayCacheInput, metadata: WalletMetadata): WalletDisplayCache {
  if (!input.snapshot.complete || !input.snapshot.network.ready) throw new Error('Only a complete verified wallet view can be cached');
  const balances = walletBalances(input.snapshot);
  // Pick public fields explicitly: raw parents, spent graphs, mempool checkpoints,
  // private keys and any unexpected caller fields never enter this record.
  const network = input.snapshot.network;
  return validateDisplayCache({ version: 1, verifiedAt: input.snapshot.observedAt, historyTruncated: input.snapshot.history.length > MAX_HISTORY,
    balances: { spendable: String(balances.spendable), pending: String(balances.pending), unsupported: String(balances.unsupported) },
    snapshot: { network: { network: network.network, chain: network.chain, genesisHash: network.genesisHash,
      height: network.height, tipHash: network.tipHash, indexedHeight: network.indexedHeight, ready: false,
      observedAt: network.observedAt, explorerUrl: network.explorerUrl, minConfirmations: network.minConfirmations,
      coinbaseMaturity: network.coinbaseMaturity, averageBlockSeconds: network.averageBlockSeconds,
      blockTimeSampleSize: network.blockTimeSampleSize, lastBlockTime: network.lastBlockTime },
      addresses: input.snapshot.addresses, utxos: [], history: input.snapshot.history.slice(0, MAX_HISTORY),
      complete: false, warnings: input.snapshot.warnings, observedAt: input.snapshot.observedAt },
    receive: input.receive, change: input.change, ownedAddresses: input.ownedAddresses }, metadata);
}
export async function encryptDisplayCache(input: DisplayCacheInput | WalletDisplayCache, metadata: WalletMetadata, key: CryptoKey, salt: string): Promise<string> {
  const cache = 'version' in input ? validateDisplayCache(input, metadata) : createDisplayCache(input, metadata);
  const plaintext = encoder.encode(JSON.stringify(cache));
  if (plaintext.byteLength > MAX_DISPLAY_CACHE_BYTES) throw new Error('Display cache exceeds size limit');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  try {
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: Uint8Array.from(iv), additionalData: Uint8Array.from(aad(metadata, salt)), tagLength: 128 }, key, Uint8Array.from(plaintext));
    return JSON.stringify({ format: 'tensorcash-display-cache', version: 1, iv: hex.encode(iv), ciphertext: hex.encode(new Uint8Array(encrypted)) });
  } finally { plaintext.fill(0); }
}
export async function decryptDisplayCache(json: string, metadata: WalletMetadata, key: CryptoKey, salt: string): Promise<WalletDisplayCache | null> {
  let plaintext: Uint8Array | undefined;
  try {
    if (json.length > MAX_DISPLAY_CACHE_BYTES * 2 + 200) return null;
    const envelope = envelopeSchema.parse(JSON.parse(json));
    plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Uint8Array.from(hex.decode(envelope.iv)), additionalData: Uint8Array.from(aad(metadata, salt)), tagLength: 128 }, key, Uint8Array.from(hex.decode(envelope.ciphertext))));
    if (plaintext.byteLength > MAX_DISPLAY_CACHE_BYTES) return null;
    return validateDisplayCache(JSON.parse(decoder.decode(plaintext)), metadata);
  } catch { return null; } finally { plaintext?.fill(0); }
}
