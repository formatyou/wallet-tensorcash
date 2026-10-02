import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app';
import { MAINNET_GENESIS } from './config';
import { RpcError } from './errors';
import type { Rpc } from './rpc';
import { decodeNativeTransaction } from '../src/core/raw';

const TIP = 'a'.repeat(64);
const OWN_SCRIPT = `0014${'1'.repeat(40)}`;
const mainAddress = `tc1q${'a'.repeat(38)}`;
const now = () => Math.floor(Date.now() / 1000);
const uint = (n: number, bytes: number) => { const b = Buffer.alloc(bytes); if (bytes === 4) b.writeUInt32LE(n); else b.writeBigUInt64LE(BigInt(n)); return b.toString('hex'); };
const body = (inputTxid: string, amount: number) => `01${Buffer.from(inputTxid, 'hex').reverse().toString('hex')}${uint(0, 4)}00ffffffff01${uint(amount, 8)}${(OWN_SCRIPT.length / 2).toString(16).padStart(2, '0')}${OWN_SCRIPT}`;
// A confirmed ordinary transfer exactly as Core stores it, witness included.
const BODY = body('c'.repeat(64), 399800);
const V_CORE = `020000000001${BODY}0202aaaa02bbbb00000000`; const V = decodeNativeTransaction(V_CORE);
// Other serializations of the same txid that the strict local decoder accepts.
const VARIANTS = [['uppercase hex', V_CORE.toUpperCase()], ['a swapped witness', `020000000001${BODY}0202dead02beef00000000`], ['a stripped serialization', `02000000${BODY}00000000`]] as const;
const CASES = VARIANTS.flatMap(([name, rawHex]) => (['validate', 'broadcast'] as const).flatMap(route => (['warm', 'cold'] as const).map(cache => ({ name, rawHex, route, cache }))));
// A well-formed transfer that neither Core nor the explorer has ever seen.
const PAYLOAD = 'cafebabedeadbeef';
const UNSEEN_RAW = `020000000001${body('d'.repeat(64), 1000)}0108${PAYLOAD}00000000`; const UNSEEN = decodeNativeTransaction(UNSEEN_RAW);
type Handler = (method: string, params: unknown[], wallet?: string) => unknown | Promise<unknown>;
class MockRpc implements Rpc {
  calls: { method: string; params: unknown[]; wallet?: string }[] = [];
  constructor(public handler: Handler) {}
  async call<T = unknown>(method: string, params: unknown[] = [], wallet?: string): Promise<T> { this.calls.push({ method, params, wallet }); return await this.handler(method, params, wallet) as T; }
}
function asset(raw: string, flags: { has_assets?: boolean; has_icu?: boolean } = {}) {
  const tx = decodeNativeTransaction(raw);
  return { txid: tx.txid, asset_summary: { has_assets: false, has_icu: false, ...flags }, vout: tx.outputs.map(o => ({ n: o.vout, value: (Number(o.amountUnits) / 1e8).toFixed(8), scriptPubKey: { hex: o.scriptHex } })) };
}
function verbose(raw: string) {
  const tx = decodeNativeTransaction(raw);
  return { txid: tx.txid, hex: raw, vin: tx.inputs.map(i => ({ txid: i.txid, vout: i.vout })), vout: asset(raw).vout };
}
function baseHandler(): Handler {
  return (method, params) => {
    switch (method) {
      case 'getblockchaininfo': return { chain: 'tensor', blocks: 200, headers: 200, bestblockhash: TIP, initialblockdownload: false };
      case 'getblockhash': return params[0] === 0 ? MAINNET_GENESIS : TIP;
      case 'getblockheader': return { time: now() };
      case 'getrawmempool': return [];
      case 'validateaddress': return { isvalid: true, address: params[0], scriptPubKey: OWN_SCRIPT };
      case 'getrawtransaction': if (params[0] === V.txid) return params[1] === true ? { ...verbose(V_CORE), confirmations: 2, blockhash: TIP, in_active_chain: true } : V_CORE; throw new RpcError(-5, 'not found');
      case 'gettxout': return params[0] === V.txid ? { bestblock: TIP, confirmations: 2, value: '0.00399800', coinbase: false, scriptPubKey: { hex: OWN_SCRIPT } } : null;
      case 'decodeassettransaction': return asset(params[0] as string);
      case 'getmempoolentry': throw new RpcError(-5, 'not found');
      default: throw new Error(`Unexpected mock RPC ${method}`);
    }
  };
}
const indexStatus = () => ({ ready: true, core_online: true, initial_block_download: false, indexed_height: 200, indexed_tip: TIP, lag_blocks: 0, checked_at: now() });
function explorerFetch(routes: Record<string, unknown>): typeof fetch {
  return (async input => {
    const url = new URL(String(input)); if (url.pathname === '/api/status') return new Response(JSON.stringify(indexStatus()), { status: 200 });
    if (!(url.pathname in routes)) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(routes[url.pathname]), { status: 200 });
  }) as typeof fetch;
}
const explorer = () => explorerFetch({
  [`/api/address/${mainAddress}`]: { status: indexStatus(), pagination: { page: 1, total: 1, total_pages: 1, has_next: false }, transactions: [{ txid: V.txid, block_height: 199, block_hash: TIP, delta_sats: 399800, fee_sats: 200, timestamp: now() - 100 }] },
  [`/api/tx/${V.txid}`]: { transaction: { txid: V.txid, is_coinbase: false, output_count: 1, block_height: 199, block_hash: TIP, outputs: [{ address: mainAddress, vout_index: 0, value_sats: 399800, script_hex: OWN_SCRIPT }] } },
});
const opened: FastifyInstance[] = [];
async function create(rpc: Rpc) { const app = await buildApp({ network: 'mainnet', rpcUrl: 'http://127.0.0.1:39242', allowedOrigins: ['https://wallet.example'], rpc, fetch: explorer() }); opened.push(app); return app; }
afterEach(async () => { await Promise.all(opened.splice(0).map(app => app.close())); });
const post = (url: string, payload: unknown, headers: Record<string, string> = {}) => ({ method: 'POST' as const, url, headers: { 'content-type': 'application/json', ...headers }, payload: JSON.stringify(payload) });
const sync = () => post('/api/v1/wallet/sync', { addresses: [mainAddress] }, { origin: 'https://wallet.example' });

describe('submitted transaction bytes and the shared raw cache', () => {
  it.each(CASES)('keeps Core bytes for a confirmed transfer after $name is submitted to $route without an Origin ($cache cache)', async ({ rawHex, route, cache }) => {
    expect(rawHex).not.toBe(V_CORE); expect(decodeNativeTransaction(rawHex).txid).toBe(V.txid);
    const rpc = new MockRpc(baseHandler()); const app = await create(rpc);
    if (cache === 'warm') expect((await app.inject(sync())).json()).toMatchObject({ complete: true, utxos: [{ txid: V.txid, verified: true, rawParent: V_CORE }] });
    const mark = rpc.calls.length; const submission = await app.inject(post(`/api/v1/tx/${route}`, { rawHex }));
    expect(submission.statusCode).toBe(200); expect(submission.json()).toEqual(route === 'validate' ? { txid: V.txid, allowed: true, alreadyKnown: true } : { txid: V.txid, status: 'already-known' });
    const submitted = rpc.calls.slice(mark).map(c => c.method);
    expect(rpc.calls.slice(mark).filter(c => c.method === 'decodeassettransaction').map(c => c.params)).toEqual([[rawHex.toLowerCase(), false]]);
    expect(submitted.indexOf('getmempoolentry')).toBeGreaterThan(submitted.indexOf('decodeassettransaction')); expect(submitted).not.toContain('sendrawtransaction');
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await app.inject(sync()); expect(response.statusCode).toBe(200); const result = response.json();
      expect(result.complete).toBe(true); expect(result.warnings.join(' ')).not.toContain('cannot be verified');
      expect(result.utxos).toHaveLength(1); expect(result.utxos[0]).toMatchObject({ txid: V.txid, vout: 0, amountUnits: '399800', classification: 'native', verified: true }); expect(result.utxos[0].rawParent).toBe(V_CORE);
    }
    const raw = await app.inject(`/api/v1/tx/${V.txid}/raw`); expect(raw.statusCode).toBe(200); expect(raw.json()).toEqual({ txid: V.txid, rawHex: V_CORE });
  });
  it('does not serve a submitted transaction that exists nowhere through the raw route', async () => {
    const rpc = new MockRpc(baseHandler()); const app = await create(rpc);
    const submission = await app.inject(post('/api/v1/tx/validate', { rawHex: UNSEEN_RAW }));
    expect(submission.statusCode).toBe(503); expect(submission.json().error.code).toBe('transaction-state-unknown');
    expect(rpc.calls.filter(c => c.method === 'decodeassettransaction').map(c => c.params)).toEqual([[UNSEEN_RAW, false]]);
    const raw = await app.inject(`/api/v1/tx/${UNSEEN.txid}/raw`); expect(raw.statusCode).toBe(404); expect(raw.body).not.toContain(PAYLOAD);
  });
  it.each(['has_assets', 'has_icu'] as const)('rejects submitted bytes that Core classifies with %s before any acceptance lookup', async flag => {
    const handler = baseHandler(); const rpc = new MockRpc((m, p, w) => m === 'decodeassettransaction' ? asset(p[0] as string, { [flag]: true }) : handler(m, p, w));
    const app = await create(rpc); const submission = await app.inject(post('/api/v1/tx/validate', { rawHex: UNSEEN_RAW }));
    expect(submission.statusCode).toBe(422); expect(submission.json().error.code).toBe('unsupported-transaction');
    expect(rpc.calls.filter(c => c.method === 'decodeassettransaction').map(c => c.params)).toEqual([[UNSEEN_RAW, false]]);
    expect(rpc.calls.some(c => c.method === 'getmempoolentry' || c.method === 'sendrawtransaction')).toBe(false);
  });
});
