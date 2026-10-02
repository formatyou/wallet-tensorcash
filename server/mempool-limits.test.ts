import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app';
import { MAINNET_GENESIS, resolveConfig, type GatewayConfig } from './config';
import { RpcError } from './errors';
import { configFromEnvironment } from './index';
import type { Rpc } from './rpc';
import { decodeNativeTransaction } from '../src/core/raw';

const TIP = 'a'.repeat(64);
const OWN_SCRIPT = `0014${'1'.repeat(40)}`;
const OTHER_SCRIPT = `0014${'2'.repeat(40)}`;
const mainAddress = `tc1q${'a'.repeat(38)}`;
const now = () => Math.floor(Date.now() / 1000);
const uint = (n: number, bytes: number) => { const b = Buffer.alloc(bytes); if (bytes === 4) b.writeUInt32LE(n); else b.writeBigUInt64LE(BigInt(n)); return b.toString('hex'); };
type Handler = (method: string, params: unknown[], wallet?: string) => unknown | Promise<unknown>;
class MockRpc implements Rpc {
  calls: { method: string; params: unknown[]; wallet?: string }[] = [];
  constructor(public handler: Handler) {}
  async call<T = unknown>(method: string, params: unknown[] = [], wallet?: string): Promise<T> { this.calls.push({ method, params, wallet }); return await this.handler(method, params, wallet) as T; }
}
// Small one-input, one-output transfers between scripts no test wallet owns.
function unrelated(n: number) {
  const raw = `0200000001${uint(n + 1, 4).padEnd(64, 'c')}0000000000ffffffff01${uint(1000 + n, 8)}16${OTHER_SCRIPT}00000000`; const tx = decodeNativeTransaction(raw);
  return { txid: tx.txid, hex: raw, vin: tx.inputs.map(i => ({ txid: i.txid, vout: i.vout })), vout: tx.outputs.map(o => ({ n: o.vout, value: (Number(o.amountUnits) / 1e8).toFixed(8), scriptPubKey: { hex: o.scriptHex } })) };
}
const indexStatus = () => ({ ready: true, core_online: true, initial_block_download: false, indexed_height: 200, indexed_tip: TIP, lag_blocks: 0, checked_at: now() });
const emptyIndex = { status: indexStatus(), pagination: { page: 1, total: 0, total_pages: 0, has_next: false }, transactions: [] };
const explorer = (async input => {
  const url = new URL(String(input)); if (url.pathname === '/api/status') return new Response(JSON.stringify(indexStatus()), { status: 200 });
  if (url.pathname === `/api/address/${mainAddress}`) return new Response(JSON.stringify(emptyIndex), { status: 200 });
  return new Response('{}', { status: 404 });
}) as typeof fetch;
const opened: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(opened.splice(0).map(app => app.close())); });
async function setup(transactions: number | ReturnType<typeof unrelated>[], extra: Partial<GatewayConfig> = {}) {
  const pool = new Map((typeof transactions === 'number' ? Array.from({ length: transactions }, (_, n) => unrelated(n)) : transactions).map(tx => [tx.txid, tx] as const));
  const rpc = new MockRpc((method, params) => {
    switch (method) {
      case 'getblockchaininfo': return { chain: 'tensor', blocks: 200, headers: 200, bestblockhash: TIP, initialblockdownload: false };
      case 'getblockhash': return params[0] === 0 ? MAINNET_GENESIS : TIP;
      case 'getblockheader': return { time: now() };
      case 'getrawmempool': return [...pool.keys()];
      case 'validateaddress': return { isvalid: true, address: params[0], scriptPubKey: OWN_SCRIPT };
      case 'getrawtransaction': { const tx = pool.get(params[0] as string); if (tx && params[1] === true) return tx; throw new RpcError(-5, 'not found'); }
      default: throw new Error(`Unexpected mock RPC ${method}`);
    }
  });
  const app = await buildApp({ network: 'mainnet', rpcUrl: 'http://127.0.0.1:19453', allowedOrigins: ['https://wallet.example'], rpc, fetch: explorer, ...extra }); opened.push(app);
  const sync = async () => (await app.inject({ method: 'POST', url: '/api/v1/wallet/sync', headers: { origin: 'https://wallet.example', 'content-type': 'application/json' }, payload: JSON.stringify({ addresses: [mainAddress] }) })).json();
  const verboseReads = (txid?: string) => rpc.calls.filter(c => c.method === 'getrawtransaction' && c.params[1] === true && (txid === undefined || c.params[0] === txid)).length;
  return { rpc, pool, sync, verboseReads };
}

describe('Core mempool limits independent of wallet history limits', () => {
  it.each([600, 5000])('keeps every wallet complete beside %i unrelated mempool transactions', async count => {
    const f = await setup(count); const result = await f.sync();
    expect(result).toMatchObject({ complete: true, utxos: [], history: [], warnings: [] }); expect(f.verboseReads()).toBe(count);
  });
  it('holds a mempool larger than the history limit in the cache between syncs', async () => {
    const f = await setup(5000); expect((await f.sync()).complete).toBe(true); expect(f.verboseReads()).toBe(5000);
    f.rpc.calls.length = 0; expect((await f.sync()).complete).toBe(true); expect(f.verboseReads()).toBe(0);
    expect(f.rpc.calls.filter(c => c.method === 'getrawmempool')).toHaveLength(2);
  });
  it('still reports an incomplete snapshot one transaction above the mempool limit', async () => {
    const above = await setup(5001); const result = await above.sync();
    expect(result.complete).toBe(false); expect(result.warnings.join(' ')).toContain('Core mempool limit'); expect(above.verboseReads()).toBe(5000);
    const atLimit = await setup(3, { maxMempoolTransactions: 3, maxHistoryTransactions: 1 }); expect((await atLimit.sync()).complete).toBe(true);
  });
  it('raises the limit and the cache through the explicit option', async () => {
    const f = await setup(5001, { maxMempoolTransactions: 20000 }); expect(await f.sync()).toMatchObject({ complete: true, warnings: [] }); expect(f.verboseReads()).toBe(5001);
    f.rpc.calls.length = 0; expect((await f.sync()).complete).toBe(true); expect(f.verboseReads()).toBe(0);
  });
  it('keeps long-lived transactions cached and evicts departed ones as the mempool turns over', async () => {
    // Sorted like the scan, the long-lived pair is the oldest insertion: plain insertion order would evict it first.
    const [keptA, keptB, goneA, goneB, newA, newB] = Array.from({ length: 6 }, (_, n) => unrelated(n)).sort((a, b) => a.txid < b.txid ? -1 : 1);
    const f = await setup([keptA, keptB, goneA, goneB], { maxMempoolTransactions: 4 }); expect((await f.sync()).complete).toBe(true); expect(f.verboseReads()).toBe(4);
    for (const tx of [goneA, goneB]) f.pool.delete(tx.txid); for (const tx of [newA, newB]) f.pool.set(tx.txid, tx); f.rpc.calls.length = 0;
    expect((await f.sync()).complete).toBe(true); expect((await f.sync()).complete).toBe(true);
    expect(f.verboseReads()).toBe(2); expect(f.verboseReads(newA.txid)).toBe(1); expect(f.verboseReads(newB.txid)).toBe(1);
    f.pool.delete(newB.txid); f.pool.set(goneA.txid, goneA); f.rpc.calls.length = 0;
    expect((await f.sync()).complete).toBe(true); expect(f.verboseReads()).toBe(1); expect(f.verboseReads(goneA.txid)).toBe(1);
  });
  it('applies the edge and hex limits to the mempool scan', async () => {
    const transactions = Array.from({ length: 3 }, (_, n) => unrelated(n));
    const edges = transactions.reduce((total, tx) => total + tx.vin.length + tx.vout.length, 0); const characters = transactions.reduce((total, tx) => total + tx.hex.length, 0);
    for (const [extra, complete] of [[{ maxMempoolEdges: edges }, true], [{ maxMempoolEdges: edges - 1 }, false], [{ maxMempoolHexCharacters: characters }, true], [{ maxMempoolHexCharacters: characters - 1 }, false]] as const) {
      const result = await (await setup(transactions, extra)).sync(); expect(result.complete).toBe(complete);
      expect(result.warnings.join(' ').includes('Core mempool graph limit')).toBe(!complete);
    }
  });
  it('resolves, bounds and reads the mempool limits from the environment', () => {
    const base: GatewayConfig = { network: 'mainnet', rpcUrl: 'http://127.0.0.1:39242', allowedOrigins: ['https://wallet.example'] };
    expect(resolveConfig(base)).toMatchObject({ maxHistoryTransactions: 500, maxMempoolTransactions: 5000, maxMempoolHexCharacters: 16_000_000, maxMempoolEdges: 100000 });
    expect(resolveConfig({ ...base, maxMempoolTransactions: 100000 }).maxMempoolEdges).toBe(2_000_000);
    for (const extra of [{ maxMempoolTransactions: 0 }, { maxMempoolHexCharacters: 1.5 }, { maxMempoolEdges: -1 }]) expect(() => resolveConfig({ ...base, ...extra })).toThrow('Invalid gateway limit');
    for (const extra of [{ maxMempoolTransactions: 100001 }, { maxMempoolHexCharacters: 64_000_001 }, { maxMempoolEdges: 2_000_001 }]) expect(() => resolveConfig({ ...base, ...extra })).toThrow('hard bound');
    expect(resolveConfig(configFromEnvironment({}).config)).toMatchObject({ maxMempoolTransactions: 5000, maxMempoolHexCharacters: 16_000_000, maxMempoolEdges: 100000 });
    expect(resolveConfig(configFromEnvironment({ WALLET_MAX_HISTORY_TRANSACTIONS: '100' }).config)).toMatchObject({ maxHistoryTransactions: 100, maxMempoolTransactions: 5000, maxMempoolHexCharacters: 16_000_000, maxMempoolEdges: 100000 });
    const environment = configFromEnvironment({ WALLET_MAX_MEMPOOL_TRANSACTIONS: '20000', WALLET_MAX_MEMPOOL_HEX_CHARACTERS: '64000000' }).config;
    expect(resolveConfig(environment)).toMatchObject({ maxMempoolTransactions: 20000, maxMempoolHexCharacters: 64_000_000, maxMempoolEdges: 400000 });
    expect(configFromEnvironment({ WALLET_MAX_MEMPOOL_EDGES: '50000' }).config.maxMempoolEdges).toBe(50000);
    expect(() => configFromEnvironment({ WALLET_MAX_MEMPOOL_TRANSACTIONS: '0' })).toThrow('Invalid WALLET_MAX_MEMPOOL_TRANSACTIONS');
    for (const environment of [{ WALLET_MAX_MEMPOOL_TRANSACTIONS: '100001' }, { WALLET_MAX_MEMPOOL_HEX_CHARACTERS: '64000001' }, { WALLET_MAX_MEMPOOL_EDGES: '2000001' }]) expect(() => resolveConfig(configFromEnvironment(environment).config)).toThrow('Gateway limit exceeds hard bound');
  });
});
