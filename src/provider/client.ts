import { z } from 'zod';
import type { BroadcastResult, FeePolicy, NetworkInfo, NetworkReadinessReason, ValidationResult, WalletSnapshot } from '../shared/types';

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const units = z.string().regex(/^(0|[1-9]\d*)$/).max(24);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const networkSchema = z.object({
  network: z.enum(['mainnet', 'regtest']), chain: z.string(), genesisHash: hash,
  height: integer, tipHash: hash, indexedHeight: integer, ready: z.boolean(),
  observedAt: z.iso.datetime(), explorerUrl: z.string().nullable(),
  minConfirmations: integer, coinbaseMaturity: integer,
  averageBlockSeconds: z.number().positive().max(86400).optional(),
  blockTimeSampleSize: z.number().int().min(1).max(144).optional(), lastBlockTime: integer.optional(),
  readinessReason: z.enum(['block-validation', 'node-sync', 'index-sync', 'index-unavailable', 'stale-data']).optional(),
  pendingValidationBlocks: integer.optional(),
});
const utxoSchema = z.object({
  txid: hash, vout: integer, address: z.string().max(100), scriptHex: z.string().regex(/^[0-9a-f]*$/).max(20000),
  amountUnits: units, confirmations: integer, blockHeight: integer.nullable(), coinbase: z.boolean(),
  classification: z.enum(['native', 'unsupported', 'unknown']),
  rawParent: z.string().regex(/^[0-9a-f]+$/).max(800000).nullable(), verified: z.boolean(),
});
const snapshotSchema = z.object({
  network: networkSchema, addresses: z.array(z.object({ address: z.string().max(100), used: z.boolean() })).max(100),
  utxos: z.array(utxoSchema).max(5000),
  history: z.array(z.object({
    txid: hash, deltaUnits: z.string().regex(/^-?(0|[1-9]\d*)$/).max(25), feeUnits: units.nullable(),
    status: z.enum(['pending', 'confirmed', 'conflicted']), confirmations: integer,
    blockHeight: integer.nullable(), timestamp: integer.nullable(),
  })).max(10000),
  complete: z.boolean(), warnings: z.array(z.string().max(500)).max(100),
  observedAt: z.iso.datetime(), mempoolFingerprint: hash.optional(),
  spentOutpoints: z.array(z.object({ txid: hash, vout: integer, spentByTxid: hash })).max(100000).optional(),
});
const feesSchema = z.object({
  relayFloorUnitsPerVbyte: units, mempoolFloorUnitsPerVbyte: units,
  suggestedRate: units, observedAt: z.iso.datetime(),
});
const validationSchema = z.object({ txid: hash, allowed: z.boolean(), alreadyKnown: z.boolean().optional(), canDiscard: z.boolean().optional(), reason: z.string().max(500).optional() });
const broadcastSchema = z.object({ txid: hash, status: z.enum(['accepted', 'already-known']) });
const GENESIS = {
  mainnet: '8fe43be4634dc48def074fa840e25a71bbdc32576eb29abf3ce2458605343720',
  regtest: 'cf63c021e5a8ea0bc04cf7b12ab12e0a7902ef2dae5bdd8cbb3a0d41c3345da4',
};
const MAX_RESPONSE_BYTES = 16_000_000;
async function readResponse(response: Response): Promise<string> {
  const length = response.headers.get('content-length');
  if (length && Number(length) > MAX_RESPONSE_BYTES) throw new Error('The provider returned an oversized response.');
  if (!response.body) throw new Error('The provider returned an empty response.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('The provider returned an oversized response.');
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export interface ChainProvider {
  network(): Promise<NetworkInfo>;
  sync(addresses: string[]): Promise<WalletSnapshot>;
  fees(): Promise<FeePolicy>;
  validate(rawHex: string): Promise<ValidationResult>;
  broadcast(rawHex: string): Promise<BroadcastResult>;
  raw(txid: string): Promise<string>;
}
export function readinessMessage(reason?: NetworkReadinessReason): string {
  switch (reason) {
    case 'block-validation': return 'Checking the latest block. Retrying automatically.';
    case 'node-sync': return 'The network is catching up. Retrying automatically.';
    case 'index-sync': return 'Updating transaction data. Retrying automatically.';
    case 'index-unavailable': return 'Transaction data is temporarily unavailable. Retrying automatically.';
    case 'stale-data': return 'Waiting for fresh network data. Retrying automatically.';
    default: return 'Waiting for the network. Retrying automatically.';
  }
}
export class NetworkReadinessError extends Error {
  readonly info: NetworkInfo;
  constructor(info: NetworkInfo, reason = info.readinessReason) {
    super(readinessMessage(reason));
    this.name = 'NetworkReadinessError';
    this.info = { ...info, ready: false, ...(reason ? { readinessReason: reason } : {}) };
  }
}
export function assertNetworkInfo(info: NetworkInfo): void {
  if (info.genesisHash !== GENESIS[info.network] || info.chain !== (info.network === 'mainnet' ? 'tensor' : 'regtest'))
    throw new Error('Gateway is connected to a different blockchain.');
  const age = Date.now() - Date.parse(info.observedAt);
  if (!Number.isFinite(age) || age < -60000 || age > 120000) throw new NetworkReadinessError(info, 'stale-data');
  if (!info.ready || info.indexedHeight !== info.height) throw new NetworkReadinessError(info);
}
export function createProvider(base = '/api/v1'): ChainProvider {
  if (!base.startsWith('/') || base.startsWith('//')) throw new Error('The wallet gateway must use the same origin.');
  async function request<T>(path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(45000),
      });
    } catch {
      throw new Error(body && path === '/tx/broadcast'
        ? 'Broadcast response was lost. Check the transaction and retry the same signed transfer.'
        : 'Network connection unavailable. Retrying automatically.');
    }
    const raw = await readResponse(response);
    let data: unknown;
    try { data = JSON.parse(raw); } catch { throw new Error('The provider returned an invalid response.'); }
    if (!response.ok) {
      const error = z.object({ error: z.object({ message: z.string().max(500) }) }).safeParse(data);
      throw new Error(error.success ? error.data.error.message : `Network request failed (${response.status}).`);
    }
    const result = schema.safeParse(data);
    if (!result.success) throw new Error('The provider returned incomplete or invalid wallet data.');
    return result.data;
  }
  return {
    async network() { const result = await request('/network', networkSchema); assertNetworkInfo(result); return result; },
    async sync(addresses) {
      if (!addresses.length || addresses.length > 100 || new Set(addresses).size !== addresses.length) throw new Error('Invalid address batch.');
      const result = await request('/wallet/sync', snapshotSchema, { addresses });
      assertNetworkInfo(result.network);
      if (result.addresses.length !== addresses.length || new Set(result.addresses.map(a => a.address)).size !== addresses.length || result.addresses.some(a => !addresses.includes(a.address))) throw new Error('The provider omitted requested addresses.');
      return result;
    },
    async fees() {
      const fees = await request('/fees', feesSchema);
      const age = Date.now() - Date.parse(fees.observedAt);
      if (age < -60000 || age > 120000) throw new Error('Fee information is stale. Refresh before continuing.');
      return fees;
    },
    validate: rawHex => request('/tx/validate', validationSchema, { rawHex }),
    broadcast: rawHex => request('/tx/broadcast', broadcastSchema, { rawHex }),
    async raw(txid) { hash.parse(txid); const result = await request(`/tx/${txid}/raw`, z.object({ rawHex: z.string().regex(/^[0-9a-f]+$/).max(800000) })); return result.rawHex; },
  };
}
