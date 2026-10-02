import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app';
import { REGTEST_GENESIS, type GatewayConfig } from './config';
import { RpcError } from './errors';
import type { Rpc } from './rpc';
import { decodeNativeTransaction } from '../src/core/raw';

const TIP = 'a'.repeat(64);
const OWN_SCRIPT = `0014${'1'.repeat(40)}`;
const OTHER_SCRIPT = `0014${'2'.repeat(40)}`;
const address = `bcrt1q${'a'.repeat(38)}`;
const SYNC_LIMIT = 16_384; const TX_LIMIT = 420_000; const RAW_MAX = 400_000;
const now = () => Math.floor(Date.now() / 1000);
const uint = (n: number, bytes: number) => { const b = Buffer.alloc(bytes); if (bytes === 4) b.writeUInt32LE(n); else b.writeBigUInt64LE(BigInt(n)); return b.toString('hex'); };
function rawTx(inputTxid = '0'.repeat(64), vout = 0xffffffff, amount = 400000, scriptHex = OWN_SCRIPT): string {
  return `0200000001${Buffer.from(inputTxid, 'hex').reverse().toString('hex')}${uint(vout, 4)}00ffffffff01${uint(amount, 8)}${(scriptHex.length / 2).toString(16).padStart(2, '0')}${scriptHex}00000000`;
}
const PARENT_RAW = rawTx(); const PARENT = decodeNativeTransaction(PARENT_RAW);
const CHILD_RAW = rawTx(PARENT.txid, 0, 399800, OTHER_SCRIPT); const CHILD = decodeNativeTransaction(CHILD_RAW);
type Handler = (method: string, params: unknown[], wallet?: string) => unknown | Promise<unknown>;
class MockRpc implements Rpc {
  calls: { method: string; params: unknown[]; wallet?: string }[] = [];
  constructor(public handler: Handler) {}
  async call<T = unknown>(method: string, params: unknown[] = [], wallet?: string): Promise<T> { this.calls.push({ method, params, wallet }); return await this.handler(method, params, wallet) as T; }
}
function asset(raw: string) {
  const tx = decodeNativeTransaction(raw);
  return { txid: tx.txid, asset_summary: { has_assets: false, has_icu: false }, vout: tx.outputs.map(o => ({ n: o.vout, value: (Number(o.amountUnits) / 1e8).toFixed(8), scriptPubKey: { hex: o.scriptHex } })) };
}
function verbose(raw: string) {
  const tx = decodeNativeTransaction(raw);
  return { txid: tx.txid, hex: raw, vin: tx.inputs.map(i => ({ txid: i.txid, vout: i.vout })), vout: asset(raw).vout };
}
function baseHandler(): Handler {
  return (method, params) => {
    switch (method) {
      case 'getblockchaininfo': return { chain: 'regtest', blocks: 200, headers: 200, bestblockhash: TIP, initialblockdownload: false };
      case 'getblockhash': return params[0] === 0 ? REGTEST_GENESIS : TIP;
      case 'getblockheader': return { time: now() };
      case 'getrawmempool': return [];
      case 'validateaddress': return { isvalid: true, address: params[0], scriptPubKey: OWN_SCRIPT };
      case 'getwalletinfo': return { private_keys_enabled: false, descriptors: true, scanning: false };
      case 'listdescriptors': return { descriptors: [{ desc: `addr(${address})#checksum` }] };
      case 'listtransactions': return [{ txid: PARENT.txid, confirmations: 101, category: 'receive' }];
      case 'gettransaction': if (params[0] === PARENT.txid) return { txid: PARENT.txid, hex: PARENT_RAW, confirmations: 101, blockhash: TIP, blockheight: 100, blocktime: now() }; throw new RpcError(-5, 'not found');
      case 'getrawtransaction': if (params[0] === PARENT.txid) return params[1] === true ? { ...verbose(PARENT_RAW), confirmations: 101, blockhash: TIP, in_active_chain: true } : PARENT_RAW; throw new RpcError(-5, 'not found');
      case 'gettxout': return { bestblock: TIP, confirmations: 101, value: '0.00400000', coinbase: true, scriptPubKey: { hex: OWN_SCRIPT } };
      case 'decodeassettransaction': return asset(params[0] as string);
      case 'getmempoolinfo': return { minrelaytxfee: 0.00001, mempoolminfee: 0.00001 };
      case 'estimatesmartfee': return { errors: ['Insufficient data'] };
      case 'getmempoolentry': throw new RpcError(-5, 'not found');
      case 'testmempoolaccept': return [{ txid: CHILD.txid, allowed: true }];
      case 'sendrawtransaction': return CHILD.txid;
      default: throw new Error(`Unexpected mock RPC ${method}`);
    }
  };
}
function config(rpc: Rpc, extra: Partial<GatewayConfig> = {}): GatewayConfig { return { network: 'regtest', rpcUrl: 'http://127.0.0.1:19453', allowedOrigins: ['https://wallet.example'], rpc, ...extra }; }
const opened: FastifyInstance[] = [];
async function create(rpc: Rpc, extra: Partial<GatewayConfig> = {}) { const app = await buildApp(config(rpc, extra)); opened.push(app); return app; }
afterEach(async () => { await Promise.all(opened.splice(0).map(app => app.close())); });
const postText = (url: string, payload: string) => ({ method: 'POST' as const, url, headers: { origin: 'https://wallet.example', 'content-type': 'application/json' }, payload });
const post = (url: string, payload: unknown) => postText(url, JSON.stringify(payload));
const invalid = { error: { code: 'invalid-request', message: 'Invalid request' } };
const TX_ROUTES = ['/api/v1/tx/validate', '/api/v1/tx/broadcast'];
const NONCANONICAL = [
  { name: 'uppercase', rawHex: CHILD_RAW.toUpperCase() },
  { name: 'mixed-case', rawHex: CHILD_RAW.replace(/[a-f]/, letter => letter.toUpperCase()) },
];
const submitted = (rpc: MockRpc) => rpc.calls.flatMap(c => c.params.flat()).filter((p): p is string => typeof p === 'string' && p.toLowerCase() === CHILD_RAW);

describe('transaction hex canonical form', () => {
  it.each(NONCANONICAL)('validates $name rawHex as lowercase bytes', async ({ rawHex }) => {
    expect(rawHex).not.toBe(CHILD_RAW); expect(rawHex.toLowerCase()).toBe(CHILD_RAW);
    const rpc = new MockRpc(baseHandler()); const app = await create(rpc); const response = await app.inject(post('/api/v1/tx/validate', { rawHex }));
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ txid: CHILD.txid, allowed: true });
    expect(rpc.calls.some(c => c.method === 'decodeassettransaction' && c.params[0] === CHILD_RAW)).toBe(true);
    expect(rpc.calls.find(c => c.method === 'testmempoolaccept')?.params[0]).toEqual([CHILD_RAW]);
    expect(submitted(rpc).length).toBeGreaterThanOrEqual(2); expect(submitted(rpc).every(value => value === CHILD_RAW)).toBe(true);
  });
  it.each(NONCANONICAL)('broadcasts $name rawHex as lowercase bytes', async ({ rawHex }) => {
    const rpc = new MockRpc(baseHandler()); const app = await create(rpc); const response = await app.inject(post('/api/v1/tx/broadcast', { rawHex }));
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ txid: CHILD.txid, status: 'accepted' });
    expect(rpc.calls.some(c => c.method === 'decodeassettransaction' && c.params[0] === CHILD_RAW)).toBe(true);
    expect(rpc.calls.find(c => c.method === 'testmempoolaccept')?.params[0]).toEqual([CHILD_RAW]);
    expect(rpc.calls.find(c => c.method === 'sendrawtransaction')?.params[0]).toBe(CHILD_RAW);
    expect(submitted(rpc).length).toBeGreaterThanOrEqual(3); expect(submitted(rpc).every(value => value === CHILD_RAW)).toBe(true);
  });
  it.each(TX_ROUTES)('rejects non-hex and odd-length rawHex on %s before any RPC call', async url => {
    const rpc = new MockRpc(baseHandler()); const app = await create(rpc);
    for (const rawHex of [`${CHILD_RAW}0`, `${CHILD_RAW.slice(0, -2)}zz`, ` ${CHILD_RAW} `, `0x${CHILD_RAW}`]) expect((await app.inject(post(url, { rawHex }))).statusCode).toBe(400);
    expect(rpc.calls).toHaveLength(0);
  });
  it('still validates and broadcasts canonical lowercase rawHex', async () => {
    const rpc = new MockRpc(baseHandler()); const app = await create(rpc);
    const validation = await app.inject(post('/api/v1/tx/validate', { rawHex: CHILD_RAW }));
    expect(validation.statusCode).toBe(200); expect(validation.json()).toEqual({ txid: CHILD.txid, allowed: true });
    const broadcast = await app.inject(post('/api/v1/tx/broadcast', { rawHex: CHILD_RAW }));
    expect(broadcast.statusCode).toBe(200); expect(broadcast.json()).toEqual({ txid: CHILD.txid, status: 'accepted' });
    expect(rpc.calls.find(c => c.method === 'sendrawtransaction')?.params[0]).toBe(CHILD_RAW);
  });
});

describe('request body limits', () => {
  it.each(TX_ROUTES)('rejects rawHex above 400000 characters on %s before any RPC call', async url => {
    const rpc = new MockRpc(baseHandler()); const app = await create(rpc); const request = post(url, { rawHex: 'ab'.repeat(RAW_MAX / 2 + 1) });
    expect(Buffer.byteLength(request.payload)).toBeLessThan(TX_LIMIT);
    const response = await app.inject(request);
    expect(response.statusCode).toBe(400); expect(response.json()).toEqual(invalid); expect(rpc.calls).toHaveLength(0);
  });
  it.each(TX_ROUTES)('passes rawHex of exactly 400000 characters on %s to transaction decoding', async url => {
    const rpc = new MockRpc(baseHandler()); const app = await create(rpc); const response = await app.inject(post(url, { rawHex: 'ab'.repeat(RAW_MAX / 2) }));
    expect(response.statusCode).toBe(422); expect(response.json().error.code).toBe('unsupported-transaction');
  });
  it.each(TX_ROUTES)('rejects a body above 420000 bytes on %s before any RPC call', async url => {
    const rpc = new MockRpc(baseHandler()); const app = await create(rpc); const request = post(url, { rawHex: 'ab'.repeat(TX_LIMIT / 2) });
    expect(Buffer.byteLength(request.payload)).toBeGreaterThan(TX_LIMIT); expect(Buffer.byteLength(request.payload)).toBeLessThan(800_000);
    const response = await app.inject(request);
    expect(response.statusCode).toBe(413); expect(response.json()).toEqual(invalid); expect(rpc.calls).toHaveLength(0);
  });
  it('rejects a wallet sync body above 16384 bytes before any RPC call', async () => {
    const rpc = new MockRpc(baseHandler()); const app = await create(rpc); const body = JSON.stringify({ addresses: [address] });
    const padded = (bytes: number) => `${body.slice(0, -1)}${' '.repeat(bytes - body.length)}}`;
    expect(JSON.parse(padded(SYNC_LIMIT + 1))).toEqual({ addresses: [address] }); expect(Buffer.byteLength(padded(SYNC_LIMIT + 1))).toBe(SYNC_LIMIT + 1);
    const response = await app.inject(postText('/api/v1/wallet/sync', padded(SYNC_LIMIT + 1)));
    expect(response.statusCode).toBe(413); expect(response.json()).toEqual(invalid); expect(rpc.calls).toHaveLength(0);
    const many = await app.inject(post('/api/v1/wallet/sync', { addresses: Array.from({ length: 200 }, (_, i) => `bcrt1q${String(i).padStart(94, 'a')}`) }));
    expect(many.statusCode).toBe(413); expect(rpc.calls).toHaveLength(0);
    const atLimit = await app.inject(postText('/api/v1/wallet/sync', padded(SYNC_LIMIT)));
    expect(atLimit.statusCode).toBe(200); expect(atLimit.json()).toMatchObject({ complete: true, addresses: [{ address, used: true }] });
  });
  it('still synchronizes 100 addresses of maximum length', async () => {
    const addresses = Array.from({ length: 100 }, (_, i) => `bcrt1q${String(i).padStart(94, 'a')}`); const handler = baseHandler();
    const rpc = new MockRpc((m, p, w) => {
      if (m === 'validateaddress') return { isvalid: true, address: p[0], scriptPubKey: `0014${addresses.indexOf(p[0] as string).toString(16).padStart(40, '0')}` };
      if (m === 'listdescriptors') return { descriptors: addresses.map(a => ({ desc: `addr(${a})#checksum` })) };
      if (m === 'listtransactions') return [];
      return handler(m, p, w);
    });
    const app = await create(rpc); const request = post('/api/v1/wallet/sync', { addresses });
    expect(addresses.every(a => a.length === 100)).toBe(true); expect(Buffer.byteLength(request.payload)).toBe(10_315);
    const response = await app.inject(request); expect(response.statusCode).toBe(200);
    const result = response.json(); expect(result).toMatchObject({ complete: true, utxos: [], history: [] });
    expect(result.addresses.map((a: { address: string }) => a.address)).toEqual(addresses);
    expect(rpc.calls.filter(c => c.method === 'validateaddress')).toHaveLength(100);
  });
});
