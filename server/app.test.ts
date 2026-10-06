import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildApp } from './app';
import { MAINNET_GENESIS, REGTEST_GENESIS, resolveConfig, type GatewayConfig } from './config';
import { RpcError } from './errors';
import { configFromEnvironment } from './index';
import type { Rpc } from './rpc';
import { decodeNativeTransaction } from '../src/core/raw';
import { coinUnits } from './data';

const TIP = 'a'.repeat(64);
const OWN_SCRIPT = `0014${'1'.repeat(40)}`;
const OTHER_SCRIPT = `0014${'2'.repeat(40)}`;
const address = `bcrt1q${'a'.repeat(38)}`;
const mainAddress = `tc1q${'a'.repeat(38)}`;
const now = () => Math.floor(Date.now() / 1000);
const uint = (n: number, bytes: number) => { const b = Buffer.alloc(bytes); if (bytes === 4) b.writeUInt32LE(n); else b.writeBigUInt64LE(BigInt(n)); return b.toString('hex'); };
function rawTx(inputTxid = '0'.repeat(64), vout = 0xffffffff, amount = 400000, scriptHex = OWN_SCRIPT): string {
  return `0200000001${Buffer.from(inputTxid, 'hex').reverse().toString('hex')}${uint(vout, 4)}00ffffffff01${uint(amount, 8)}${(scriptHex.length / 2).toString(16).padStart(2, '0')}${scriptHex}00000000`;
}
function rawOutputs(inputTxid: string, outputs: { amount: number; scriptHex: string }[]) {
  return `0200000001${Buffer.from(inputTxid, 'hex').reverse().toString('hex')}0000000000ffffffff${outputs.length.toString(16).padStart(2, '0')}${outputs.map(o => `${uint(o.amount, 8)}${(o.scriptHex.length / 2).toString(16).padStart(2, '0')}${o.scriptHex}`).join('')}00000000`;
}
const PARENT_RAW = rawTx(); const PARENT = decodeNativeTransaction(PARENT_RAW);
const CHILD_RAW = rawTx(PARENT.txid, 0, 399800, OTHER_SCRIPT); const CHILD = decodeNativeTransaction(CHILD_RAW);
type Handler = (method: string, params: unknown[], wallet?: string) => unknown | Promise<unknown>;
class MockRpc implements Rpc {
  calls: { method: string; params: unknown[]; wallet?: string }[] = [];
  constructor(public handler: Handler) {}
  async call<T = unknown>(method: string, params: unknown[] = [], wallet?: string): Promise<T> { this.calls.push({ method, params, wallet }); return await this.handler(method, params, wallet) as T; }
}
function asset(raw: string, flags = false) {
  const tx = decodeNativeTransaction(raw);
  return { txid: tx.txid, asset_summary: { has_assets: flags, has_icu: false }, vout: tx.outputs.map(o => ({ n: o.vout, value: (Number(o.amountUnits) / 1e8).toFixed(8), scriptPubKey: { hex: o.scriptHex } })) };
}
function verbose(raw: string) {
  const tx = decodeNativeTransaction(raw);
  return { txid: tx.txid, hex: raw, vin: tx.inputs.map(i => ({ txid: i.txid, vout: i.vout })), vout: asset(raw).vout };
}
function baseHandler(network: 'mainnet' | 'regtest' = 'regtest'): Handler {
  return (method, params) => {
    switch (method) {
      case 'getblockchaininfo': return { chain: network === 'mainnet' ? 'tensor' : 'regtest', blocks: 200, headers: 200, bestblockhash: TIP, initialblockdownload: false };
      case 'getblockhash': return params[0] === 0 ? network === 'mainnet' ? MAINNET_GENESIS : REGTEST_GENESIS : TIP;
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
const staticDirectories: string[] = [];
async function create(rpc: Rpc, extra: Partial<GatewayConfig> = {}) { const app = await buildApp(config(rpc, extra)); opened.push(app); return app; }
afterEach(async () => { await Promise.all(opened.splice(0).map(app => app.close())); await Promise.all(staticDirectories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const post = (url: string, payload: unknown) => ({ method: 'POST' as const, url, headers: { origin: 'https://wallet.example', 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
const indexStatus = () => ({ ready: true, core_online: true, initial_block_download: false, indexed_height: 200, indexed_tip: TIP, lag_blocks: 0, checked_at: now() });
const validationWaitStatus = () => ({ ...indexStatus(), ready: false, state: 'syncing', core_height: 200,
  core_headers: 201, effective_work_ready: true, verification_progress: 1, tip_age_seconds: 1,
  warnings: ['TensorCash Core is still synchronizing the chain.'] });
function explorerFetch(routes: Record<string, unknown>): typeof fetch {
  return (async input => {
    const url = new URL(String(input)); if (url.pathname === '/api/status') return new Response(JSON.stringify(indexStatus()), { status: 200 });
    if (!(url.pathname in routes)) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(routes[url.pathname]), { status: 200 });
  }) as typeof fetch;
}
describe('gateway network and request boundary', () => {
  it('rejects wrong genesis before wallet or signing calls', async () => {
    const handler = baseHandler(); const rpc = new MockRpc((m, p, w) => m === 'getblockhash' ? 'b'.repeat(64) : handler(m, p, w));
    const app = await create(rpc); const result = await app.inject(post('/api/v1/wallet/sync', { addresses: [address] }));
    expect(result.statusCode).toBe(503); expect(rpc.calls.some(c => c.method === 'listtransactions')).toBe(false);
  });
  it('returns incomplete empty snapshot during initial block download', async () => {
    const handler = baseHandler(); const rpc = new MockRpc((m, p, w) => m === 'getblockchaininfo' ? { chain: 'regtest', blocks: 200, headers: 300, bestblockhash: TIP, initialblockdownload: true } : handler(m, p, w));
    const app = await create(rpc); const result = await app.inject(post('/api/v1/wallet/sync', { addresses: [address] }));
    expect(result.statusCode).toBe(200); expect(result.json()).toMatchObject({ complete: false, utxos: [], network: { ready: false } });
  });
  it('denies other origins, browser cross-site mutations, and non-JSON bodies', async () => {
    const rpc = new MockRpc(baseHandler()); const app = await create(rpc);
    expect((await app.inject({ ...post('/api/v1/wallet/sync', { addresses: [address] }), headers: { origin: 'https://evil.example', 'content-type': 'application/json' } })).statusCode).toBe(403);
    expect((await app.inject({ ...post('/api/v1/wallet/sync', { addresses: [address] }), headers: { origin: 'https://wallet.example', 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/v1/wallet/sync', headers: { 'content-type': 'text/plain' }, payload: '{}' })).statusCode).toBe(415);
    expect(rpc.calls).toHaveLength(0);
  });
  it('rejects private metadata, unknown fields, duplicate addresses, and more than 100 addresses', async () => {
    const rpc = new MockRpc(baseHandler()); const app = await create(rpc);
    for (const payload of [{ addresses: [address], seed: 'never-log-this' }, { addresses: [address, address] }, { addresses: Array(101).fill(address) }]) expect((await app.inject(post('/api/v1/wallet/sync', payload))).statusCode).toBe(400);
    expect((await app.inject(post('/api/v1/tx/validate', { rawHex: CHILD_RAW, privateKey: 'never-log-this' }))).body).not.toContain('never-log-this');
    expect(rpc.calls).toHaveLength(0);
  });
  it('sets strict CSP and exposes no generic RPC endpoint', async () => {
    const app = await create(new MockRpc(baseHandler())); const response = await app.inject('/api/v1/network');
    expect(response.headers['content-security-policy']).toContain("script-src 'self'"); expect(response.headers['content-security-policy']).not.toContain('unsafe-inline');
    expect((await app.inject(post('/api/v1/rpc', { method: 'walletpassphrase' }))).statusCode).toBe(404);
  });
  it('prevents caching HTML documents including static index and SPA navigation without changing asset headers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wallet-html-test-')); staticDirectories.push(directory);
    await mkdir(join(directory, 'assets'));
    await writeFile(join(directory, 'index.html'), '<!doctype html><html><head><title>unit-wallet-index</title></head><body></body></html>');
    await writeFile(join(directory, 'assets', 'app-01234567.js'), 'console.log("unit-bundled-asset");');
    const app = await create(new MockRpc(baseHandler()), { staticDir: directory });
    for (const url of ['/', '/index.html', '/wallet/receive']) {
      const response = await app.inject({ method: 'GET', url, headers: { accept: 'text/html' } });
      expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['content-type']).toContain('text/html'); expect(response.body).toContain('unit-wallet-index');
    }
    const asset = await app.inject('/assets/app-01234567.js');
    expect(asset.statusCode).toBe(200); expect(asset.body).toContain('unit-bundled-asset'); expect(asset.headers['cache-control']).toBeUndefined();
  });
  it('pins watch-only creation to independent regtest port', () => {
    expect(() => resolveConfig(config(new MockRpc(baseHandler()), { rpcUrl: 'http://127.0.0.1:19443', allowWatchWalletCreation: true }))).toThrow('isolated');
    expect(() => resolveConfig(config(new MockRpc(baseHandler()), { network: 'mainnet', allowWatchWalletCreation: true }))).toThrow('isolated');
    expect(() => resolveConfig(config(new MockRpc(baseHandler()), { rpcUrl: 'http://127.0.0.1:19443', allowWatchWalletCreation: false }))).toThrow('isolated');
  });
  it('trusts forwarded client addresses only from loopback proxy', async () => {
    const app = await create(new MockRpc(baseHandler()), { syncRateLimit: 2 });
    for (let i = 0; i < 2; i++) expect((await app.inject({ ...post('/api/v1/wallet/sync', { addresses: [address] }), remoteAddress: '203.0.113.10', headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${i + 1}` } })).statusCode).toBe(200);
    expect((await app.inject({ ...post('/api/v1/wallet/sync', { addresses: [address] }), remoteAddress: '203.0.113.10', headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.3' } })).statusCode).toBe(429);
    for (let i = 0; i < 3; i++) expect((await app.inject({ ...post('/api/v1/wallet/sync', { addresses: [address] }), remoteAddress: '127.0.0.1', headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${i + 20}` } })).statusCode).toBe(200);
  });
});

describe('confirmation policy', () => {
  it('defaults mainnet to two confirmations and regtest to one in both configuration paths', () => {
    for (const network of ['mainnet', 'regtest'] as const) {
      const expected = network === 'mainnet' ? 2 : 1;
      expect(resolveConfig(config(new MockRpc(baseHandler(network)), { network })).minConfirmations).toBe(expected);
      const environment = configFromEnvironment({ WALLET_NETWORK: network }).config;
      expect(environment.minConfirmations).toBe(expected);
      expect(resolveConfig(environment).coinbaseMaturity).toBe(100);
    }
  });
  it.each(['7200', '1', '0', 'invalid'])('ignores the retired mining-age environment setting %s', value => {
    const environment = configFromEnvironment({ WALLET_MAX_TIP_AGE: value }).config;
    expect(environment).not.toHaveProperty('maxTipAgeSeconds');
    expect(resolveConfig(environment)).not.toHaveProperty('maxTipAgeSeconds');
    expect(environment.minConfirmations).toBe(2);
  });
  it('honors an explicit environment confirmation minimum and rejects zero', () => {
    const environment = configFromEnvironment({ WALLET_MIN_CONFIRMATIONS: '4' }).config;
    expect(resolveConfig(environment).minConfirmations).toBe(4);
    expect(() => configFromEnvironment({ WALLET_MIN_CONFIRMATIONS: '0' })).toThrow('Invalid WALLET_MIN_CONFIRMATIONS');
    expect(() => resolveConfig(config(new MockRpc(baseHandler()), { minConfirmations: 0 }))).toThrow('Invalid gateway limit');
  });
  it.each([0, 1, 2])('enforces the mainnet minimum on a native non-coinbase input with %i confirmations', async confirmations => {
    const parentRaw = rawTx('f'.repeat(64), 0); const parent = decodeNativeTransaction(parentRaw);
    const childRaw = rawTx(parent.txid, 0, 399800, OTHER_SCRIPT); const child = decodeNativeTransaction(childRaw);
    const handler = baseHandler('mainnet');
    const rpc = new MockRpc((m, p, w) => {
      if (m === 'gettxout') return { bestblock: TIP, confirmations, value: '0.00400000', coinbase: false, scriptPubKey: { hex: OWN_SCRIPT } };
      if (m === 'getrawtransaction' && p[0] === parent.txid) return p[1] === true ? verbose(parentRaw) : parentRaw;
      if (m === 'testmempoolaccept') return [{ txid: child.txid, allowed: true }];
      return handler(m, p, w);
    });
    const app = await create(rpc, { network: 'mainnet', fetch: explorerFetch({}) });
    const response = await app.inject(post('/api/v1/tx/validate', { rawHex: childRaw }));
    expect(response.statusCode).toBe(200); expect(response.json().allowed).toBe(confirmations >= 2);
    expect(rpc.calls.some(call => call.method === 'testmempoolaccept')).toBe(confirmations >= 2);
  });
  it.each([99, 100])('preserves the mainnet coinbase maturity at %i confirmations', async confirmations => {
    const handler = baseHandler('mainnet');
    const rpc = new MockRpc((m, p, w) => m === 'gettxout' ? { bestblock: TIP, confirmations, value: '0.00400000', coinbase: true, scriptPubKey: { hex: OWN_SCRIPT } } : handler(m, p, w));
    const app = await create(rpc, { network: 'mainnet', fetch: explorerFetch({}) });
    const response = await app.inject(post('/api/v1/tx/validate', { rawHex: CHILD_RAW }));
    expect(response.statusCode).toBe(200); expect(response.json().allowed).toBe(confirmations >= 100);
    expect(rpc.calls.some(call => call.method === 'testmempoolaccept')).toBe(confirmations >= 100);
  });
});

describe('wallet operations during long block gaps', () => {
  function gapFixture(tipAge: number, options: { status?: Record<string, unknown>; historyStatus?: Record<string, unknown>; spent?: boolean } = {}) {
    const handler = baseHandler('mainnet');
    const rpc = new MockRpc((m, p, w) => {
      if (m === 'getblockheader') return { time: now() - tipAge };
      if (m === 'gettxout' && (options.spent || p[0] !== PARENT.txid)) return null;
      return handler(m, p, w);
    });
    const status = () => ({ ...indexStatus(), ready: false, state: 'syncing', core_height: 200, core_headers: 200,
      effective_work_ready: true, verification_progress: 1, tip_age_seconds: tipAge,
      warnings: ['The Core chain tip is older than 30 minutes.'], ...options.status });
    const fetcher = (async input => {
      const url = new URL(String(input));
      if (url.pathname === '/api/status') return Response.json(status());
      if (url.pathname === `/api/address/${mainAddress}`) return Response.json({ status: { ...status(), ...options.historyStatus },
        pagination: { page: 1, total: 1, total_pages: 1, has_next: false },
        transactions: [{ txid: PARENT.txid, block_height: 100, block_hash: TIP, delta_sats: 400000, fee_sats: 0, timestamp: now() - tipAge }] });
      if (url.pathname === `/api/tx/${PARENT.txid}`) return Response.json({ transaction: { txid: PARENT.txid, is_coinbase: true, output_count: 1,
        outputs: [{ address: mainAddress, vout_index: 0, value_sats: 400000, script_hex: OWN_SCRIPT }] } });
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    return { rpc, fetcher };
  }
  it.each([2600, 7201, 86400, 7 * 86400])('reads balances and broadcasts through Core after a %i-second block gap', async tipAge => {
    const { rpc, fetcher } = gapFixture(tipAge);
    const app = await create(rpc, { network: 'mainnet', fetch: fetcher });
    expect((await app.inject('/health')).statusCode).toBe(200);
    expect((await app.inject('/api/v1/network')).json()).toMatchObject({ ready: true, height: 200, indexedHeight: 200 });
    expect((await app.inject('/api/v1/fees')).statusCode).toBe(200);
    const snapshot = await app.inject(post('/api/v1/wallet/sync', { addresses: [mainAddress] }));
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json()).toMatchObject({ complete: true, network: { ready: true }, utxos: [{ txid: PARENT.txid, amountUnits: '400000', verified: true, confirmations: 101 }] });
    expect((await app.inject(post('/api/v1/tx/validate', { rawHex: CHILD_RAW }))).json()).toMatchObject({ allowed: true, txid: CHILD.txid });
    const broadcast = await app.inject(post('/api/v1/tx/broadcast', { rawHex: CHILD_RAW }));
    expect(broadcast.statusCode).toBe(200); expect(broadcast.json()).toEqual({ txid: CHILD.txid, status: 'accepted' });
    expect(rpc.calls.some(call => call.method === 'testmempoolaccept')).toBe(true);
    expect(rpc.calls.filter(call => call.method === 'sendrawtransaction')).toHaveLength(1);
  });
  it.each([
    { checked_at: now() - 31 }, { indexed_tip: 'b'.repeat(64) }, { lag_blocks: 1 },
    { core_online: false }, { initial_block_download: true },
    { warnings: ['The Core chain tip is older than 30 minutes.', 'Unknown provider failure'] },
  ])('does not let an age-only warning bypass inconsistent observations: %j', async status => {
    const { rpc, fetcher } = gapFixture(86400, { status });
    const app = await create(rpc, { network: 'mainnet', fetch: fetcher });
    expect((await app.inject('/health')).statusCode).toBe(503);
    expect((await app.inject(post('/api/v1/tx/broadcast', { rawHex: CHILD_RAW }))).statusCode).toBe(503);
    expect(rpc.calls.some(call => ['testmempoolaccept', 'sendrawtransaction'].includes(call.method))).toBe(false);
  });
  it.each([
    { indexed_tip: 'b'.repeat(64) }, { checked_at: now() - 31 },
    { warnings: ['The Core chain tip is older than 30 minutes.', 'Unknown history failure'] },
  ])('still rejects an inconsistent address-history page during a long block gap: %j', async historyStatus => {
    const { rpc, fetcher } = gapFixture(86400, { historyStatus });
    const app = await create(rpc, { network: 'mainnet', fetch: fetcher });
    expect((await app.inject(post('/api/v1/wallet/sync', { addresses: [mainAddress] }))).json().complete).toBe(false);
  });
  it('still prevents broadcasting a spent input during a long block gap', async () => {
    const { rpc, fetcher } = gapFixture(86400, { spent: true });
    const app = await create(rpc, { network: 'mainnet', fetch: fetcher });
    const result = await app.inject(post('/api/v1/tx/broadcast', { rawHex: CHILD_RAW }));
    expect(result.statusCode).toBe(503); expect(result.json().error.code).toBe('transaction-state-unknown');
    expect(rpc.calls.some(call => call.method === 'sendrawtransaction')).toBe(false);
  });
});

describe('optional own-Core block timing', () => {
  const oldHash = 'b'.repeat(64); const tipTime = now();
  function timingRpc(oldTime: number, options: { fail?: boolean; reorg?: boolean } = {}) {
    const handler = baseHandler('mainnet'); return new MockRpc((m, p, w) => {
      if (m === 'getblockhash' && p[0] === 180) return oldHash;
      if (m === 'getblockhash' && p[0] === 200) return options.reorg ? 'c'.repeat(64) : TIP;
      if (m === 'getblockheader') {
        if (p[0] === TIP) return { time: tipTime, height: 200, hash: TIP };
        if (options.fail) throw new RpcError(-5, 'unavailable');
        return { time: oldTime, height: 180, hash: oldHash };
      }
      return handler(m, p, w);
    });
  }
  it('returns the observed 20-interval arithmetic mean and shares immutable timing reads across concurrent requests', async () => {
    const rpc = timingRpc(tipTime - 12000); const app = await create(rpc, { network: 'mainnet', fetch: explorerFetch({}) });
    const responses = await Promise.all(Array.from({ length: 3 }, () => app.inject('/api/v1/network')));
    for (const response of responses) expect(response.json()).toMatchObject({ ready: true, averageBlockSeconds: 600, blockTimeSampleSize: 20, lastBlockTime: tipTime });
    await app.inject('/api/v1/network'); expect(rpc.calls.filter(c => c.method === 'getblockheader' && c.params[0] === oldHash)).toHaveLength(1);
    expect(rpc.calls.filter(c => c.method === 'getblockhash' && c.params[0] === 180)).toHaveLength(1);
  });
  it('omits timing after unavailable, nonpositive, excessive or reorged samples without changing readiness', async () => {
    for (const [oldTime, options] of [[tipTime, {}], [tipTime + 1, {}], [tipTime - 20 * 86401, {}], [tipTime - 12000, { fail: true }], [tipTime - 12000, { reorg: true }]] as const) {
      const app = await create(timingRpc(oldTime, options), { network: 'mainnet', fetch: explorerFetch({}) }); const result = (await app.inject('/api/v1/network')).json();
      expect(result.ready).toBe(true); expect(result.averageBlockSeconds).toBeUndefined(); expect(result.blockTimeSampleSize).toBeUndefined(); expect(result.lastBlockTime).toBe(tipTime);
    }
  });
  it('does not estimate automatically mined block cadence on regtest', async () => {
    const rpc = new MockRpc(baseHandler()); const app = await create(rpc); const result = (await app.inject('/api/v1/network')).json();
    expect(result.ready).toBe(true); expect(result.lastBlockTime).toBeGreaterThan(0); expect(result.averageBlockSeconds).toBeUndefined(); expect(rpc.calls.filter(c => c.method === 'getblockhash')).toHaveLength(1);
  });
});

describe('watch-only synchronization and outpoint verification', () => {
  it('verifies native raw and current output and retains coinbase maturity metadata', async () => {
    const rpc = new MockRpc(baseHandler()); const app = await create(rpc); const response = await app.inject(post('/api/v1/wallet/sync', { addresses: [address] }));
    expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ complete: true, addresses: [{ address, used: true }], utxos: [{ txid: PARENT.txid, amountUnits: '400000', classification: 'native', verified: true, rawParent: PARENT_RAW, coinbase: true, confirmations: 101 }] });
    expect(response.json().mempoolFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(rpc.calls.filter(c => c.method === 'gettxout')[0].params).toEqual([PARENT.txid, 0, true]);
  });
  it('never imports into a wallet containing private keys', async () => {
    const handler = baseHandler(); const rpc = new MockRpc((m, p, w) => m === 'getwalletinfo' ? { private_keys_enabled: true, descriptors: true, scanning: false } : handler(m, p, w));
    const app = await create(rpc); expect((await app.inject(post('/api/v1/wallet/sync', { addresses: [address] }))).statusCode).toBe(503);
    expect(rpc.calls.some(c => c.method === 'importdescriptors')).toBe(false);
  });
  it('excludes classification unknown/asset outputs from spendable candidates', async () => {
    const handler = baseHandler(); const rpc = new MockRpc((m, p, w) => m === 'decodeassettransaction' ? asset(p[0] as string, true) : handler(m, p, w));
    const app = await create(rpc); const response = await app.inject(post('/api/v1/wallet/sync', { addresses: [address] }));
    expect(response.json().utxos[0]).toMatchObject({ classification: 'unsupported', verified: false, rawParent: null });
  });
  it('flags mempool races even when chain tip is unchanged', async () => {
    const handler = baseHandler(); let poolCalls = 0; const rpc = new MockRpc((m, p, w) => m === 'getrawmempool' ? (++poolCalls === 1 ? [] : [CHILD.txid]) : handler(m, p, w));
    const app = await create(rpc); const response = await app.inject(post('/api/v1/wallet/sync', { addresses: [address] }));
    expect(response.json().complete).toBe(false); expect(response.json().warnings.join(' ')).toContain('mempool changed');
  });
  it('does not emit spend graph entries from another wallet profile in the shared regtest watcher', async () => {
    const unrelatedParentRaw = rawTx(undefined, undefined, 400000, OTHER_SCRIPT); const unrelatedParent = decodeNativeTransaction(unrelatedParentRaw);
    const unrelatedRaw = rawTx(unrelatedParent.txid, 0, 399800, OTHER_SCRIPT); const unrelated = decodeNativeTransaction(unrelatedRaw); const handler = baseHandler();
    const rpc = new MockRpc((m, p, w) => {
      if (m === 'listtransactions') return [{ txid: PARENT.txid }, { txid: unrelatedParent.txid }, { txid: unrelated.txid }];
      if (m === 'gettransaction' && p[0] === unrelatedParent.txid) return { hex: unrelatedParentRaw, confirmations: 101, blockheight: 100, blockhash: TIP };
      if (m === 'gettransaction' && p[0] === unrelated.txid) return { hex: unrelatedRaw, confirmations: 1, blockheight: 200, blockhash: TIP };
      return handler(m, p, w);
    }); const app = await create(rpc); const result = (await app.inject(post('/api/v1/wallet/sync', { addresses: [address] }))).json();
    expect(result.complete).toBe(true); expect(result.history.map((h: { txid: string }) => h.txid)).toEqual([PARENT.txid]); expect(result.spentOutpoints).toEqual([]);
  });
  it('fails closed if indexed amount differs from actual Core value', async () => {
    const handler = baseHandler(); const rpc = new MockRpc((m, p, w) => m === 'gettxout' ? { bestblock: TIP, confirmations: 101, coinbase: true, value: '0.00399999', scriptPubKey: { hex: OWN_SCRIPT } } : handler(m, p, w));
    const app = await create(rpc); expect((await app.inject(post('/api/v1/wallet/sync', { addresses: [address] }))).statusCode).toBe(503);
  });
});

describe('TSCScan address and pending history', () => {
  it('returns a complete accepted-tip address view during explicit validation-only waiting', async () => {
    const handler = baseHandler('mainnet');
    const rpc = new MockRpc((m, p, w) => m === 'getblockchaininfo' ? { chain: 'tensor', blocks: 200, headers: 201, bestblockhash: TIP, initialblockdownload: false } : handler(m, p, w));
    const fetcher = (async input => {
      const url = new URL(String(input));
      if (url.pathname === '/api/status') return Response.json(validationWaitStatus());
      if (url.pathname === `/api/address/${mainAddress}`) return Response.json({ status: validationWaitStatus(), transactions: [],
        pagination: { page: 1, has_next: false, total: 0, total_pages: 0 } });
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const app = await create(rpc, { network: 'mainnet', fetch: fetcher });
    const result = (await app.inject(post('/api/v1/wallet/sync', { addresses: [mainAddress] }))).json();
    expect(result).toMatchObject({ complete: true, network: { ready: true, height: 200, indexedHeight: 200, pendingValidationBlocks: 1 }, utxos: [] });
  });
  it('subtracts pending input despite spent_by_txid=null on confirmed output', async () => {
    const pending = decodeNativeTransaction(rawTx(PARENT.txid, 0, 399800));
    const history = { status: indexStatus(), address: {}, pagination: { page: 1, page_size: 100, total: 2, total_pages: 1, has_next: false }, transactions: [{ txid: PARENT.txid, block_height: 100, block_hash: TIP, delta_sats: 400000, fee_sats: 0, timestamp: now() - 100 }, { txid: pending.txid, block_height: null, status: 'pending', delta_sats: -200, fee_sats: 200, timestamp: now() }] };
    const parentDetail = { transaction: { txid: PARENT.txid, is_coinbase: true, input_count: 1, output_count: 1, inputs: [{ prev_txid: null }], outputs: [{ address: mainAddress, vout_index: 0, value_sats: 400000, script_hex: OWN_SCRIPT, spent_by_txid: null }] } };
    const pendingDetail = { transaction: { txid: pending.txid, is_coinbase: false, input_count: 1, output_count: 1, inputs: [{ prev_txid: PARENT.txid, prev_vout: 0 }], outputs: [{ address: mainAddress, vout_index: 0, value_sats: 399800, script_hex: OWN_SCRIPT, spent_by_txid: null }] } };
    const handler = baseHandler('mainnet'); const pendingRaw = rawTx(PARENT.txid, 0, 399800);
    const rpc = new MockRpc((m, p, w) => m === 'gettxout' ? null : m === 'getrawmempool' ? [pending.txid] : m === 'getmempoolentry' ? { time: now() } : m === 'getrawtransaction' && p[0] === pending.txid ? p[1] === true ? verbose(pendingRaw) : pendingRaw : handler(m, p, w));
    const app = await create(rpc, { network: 'mainnet', fetch: explorerFetch({ [`/api/address/${mainAddress}`]: history, [`/api/tx/${PARENT.txid}`]: parentDetail, [`/api/tx/${pending.txid}`]: pendingDetail }) });
    const response = await app.inject(post('/api/v1/wallet/sync', { addresses: [mainAddress] }));
    expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ complete: true, utxos: [], addresses: [{ address: mainAddress, used: true }] });
    expect(rpc.calls.some(c => c.method === 'gettxout' && c.params[0] === PARENT.txid)).toBe(false);
    expect(rpc.calls.some(c => ['createwallet', 'importdescriptors', 'listtransactions'].includes(c.method))).toBe(false);
  });
  it('does not claim complete when pagination cap is reached', async () => {
    const payload = { status: indexStatus(), pagination: { page: 1, total: 101, total_pages: 2, has_next: true }, transactions: [] };
    const app = await create(new MockRpc(baseHandler('mainnet')), { network: 'mainnet', maxHistoryPages: 1, fetch: explorerFetch({ [`/api/address/${mainAddress}`]: payload }) });
    expect((await app.inject(post('/api/v1/wallet/sync', { addresses: [mainAddress] }))).json().complete).toBe(false);
  });
});

describe('authoritative Core mempool overlay', () => {
  const changeAddress = `tc1q${'b'.repeat(38)}`; const changeScript = `0014${'3'.repeat(40)}`;
  const indexed = (transactions: unknown[]) => ({ status: indexStatus(), pagination: { page: 1, total: transactions.length, total_pages: transactions.length ? 1 : 0, has_next: false }, transactions });
  const fundingRow = { txid: PARENT.txid, block_height: 100, block_hash: TIP, delta_sats: 400000, fee_sats: 0, timestamp: now() - 100 };
  const fundingDetail = { transaction: { txid: PARENT.txid, is_coinbase: true, output_count: 1, inputs: [{ prev_txid: null }], outputs: [{ address: mainAddress, vout_index: 0, value_sats: 400000, script_hex: OWN_SCRIPT, spent_by_txid: null }] } };
  function setup(raw: string, options: { indexedPending?: boolean; emptyIndex?: boolean; otherRaw?: string; rpcOverride?: Handler; limit?: number } = {}) {
    const tx = decodeNativeTransaction(raw); const handler = baseHandler('mainnet');
    const rpc = new MockRpc(async (m, p, w) => {
      const override = await options.rpcOverride?.(m, p, w); if (override !== undefined) return override;
      if (m === 'getrawmempool') return [tx.txid];
      if (m === 'validateaddress') return { isvalid: true, address: p[0], scriptPubKey: p[0] === changeAddress ? changeScript : OWN_SCRIPT };
      if (m === 'getrawtransaction' && p[0] === tx.txid) return p[1] === true ? verbose(raw) : raw;
      if (m === 'getrawtransaction' && options.otherRaw && p[0] === decodeNativeTransaction(options.otherRaw).txid) return p[1] === true ? verbose(options.otherRaw) : options.otherRaw;
      if (m === 'getmempoolentry') return { time: now() - 1 };
      if (m === 'gettxout') {
        if (p[0] === PARENT.txid) return null;
        if (p[0] === tx.txid) { const output = tx.outputs[p[1] as number]; return { bestblock: TIP, confirmations: 0, value: (Number(output.amountUnits) / 1e8).toFixed(8), coinbase: false, scriptPubKey: { hex: output.scriptHex } }; }
      }
      return handler(m, p, w);
    });
    const rows = options.emptyIndex ? [] : [fundingRow];
    if (options.indexedPending) rows.push({ txid: tx.txid, block_height: null as unknown as number, block_hash: null as unknown as string, delta_sats: -100200, fee_sats: 200, timestamp: now() - 1 });
    const fetch = explorerFetch({ [`/api/address/${mainAddress}`]: indexed(rows), [`/api/address/${changeAddress}`]: indexed([]), [`/api/tx/${PARENT.txid}`]: fundingDetail });
    return { tx, rpc, create: () => create(rpc, { network: 'mainnet', fetch, ...(options.limit ? { maxMempoolTransactions: options.limit } : {}) }) };
  }
  it('shows outgoing history and unconfirmed change while the explorer omits the spend entirely', async () => {
    const raw = rawOutputs(PARENT.txid, [{ amount: 100000, scriptHex: OTHER_SCRIPT }, { amount: 299800, scriptHex: changeScript }]); const f = setup(raw); const app = await f.create();
    const response = await app.inject(post('/api/v1/wallet/sync', { addresses: [mainAddress, changeAddress] })); expect(response.statusCode).toBe(200);
    const result = response.json(); expect(result.complete).toBe(true); expect(result.history.find((h: { txid: string }) => h.txid === f.tx.txid)).toMatchObject({ status: 'pending', deltaUnits: '-100200', feeUnits: '200' });
    expect(result.utxos).toHaveLength(1); expect(result.utxos[0]).toMatchObject({ txid: f.tx.txid, vout: 1, amountUnits: '299800', confirmations: 0, classification: 'native', verified: true });
    expect(result.spentOutpoints).toEqual([{ txid: PARENT.txid, vout: 0, spentByTxid: f.tx.txid }]); expect(result.addresses.every((a: { used: boolean }) => a.used)).toBe(true);
  });
  it('requires fresh confirmed block membership even when raw bytes are cached and still checks a claimed-spent Core output', async () => {
    const rows = indexed([fundingRow, { txid: CHILD.txid, block_height: 200, block_hash: TIP, delta_sats: -400000, fee_sats: 200, timestamp: now() }]);
    const childDetail = { transaction: { txid: CHILD.txid, is_coinbase: false, output_count: 1, inputs: [{ prev_txid: PARENT.txid, prev_vout: 0 }], outputs: [{ address: changeAddress, vout_index: 0, value_sats: 399800, script_hex: OTHER_SCRIPT }] } };
    for (const included of [false, true]) {
      const handler = baseHandler('mainnet'); const rpc = new MockRpc((m, p, w) => {
        if (m === 'getrawtransaction' && p[0] === CHILD.txid) { if (p[1] === true) { if (!included) throw new RpcError(-5, 'not in block'); return { ...verbose(CHILD_RAW), in_active_chain: true, blockhash: TIP, confirmations: 1 }; } return CHILD_RAW; }
        return handler(m, p, w);
      }); const app = await create(rpc, { network: 'mainnet', fetch: explorerFetch({ [`/api/address/${mainAddress}`]: rows, [`/api/tx/${PARENT.txid}`]: fundingDetail, [`/api/tx/${CHILD.txid}`]: childDetail }) });
      expect((await app.inject(`/api/v1/tx/${CHILD.txid}/raw`)).statusCode).toBe(200);
      const result = (await app.inject(post('/api/v1/wallet/sync', { addresses: [mainAddress] }))).json();
      expect(result.complete).toBe(false); expect(result.utxos[0]).toMatchObject({ txid: PARENT.txid, verified: true });
      expect(result.spentOutpoints).toEqual(included ? [{ txid: PARENT.txid, vout: 0, spentByTxid: CHILD.txid }] : []);
      expect(result.warnings.join(' ')).toContain(included ? 'conflicts with a current Core output' : 'Confirmed transfer raw data cannot be verified');
      expect(rpc.calls.some(c => c.method === 'gettxout' && c.params[0] === PARENT.txid)).toBe(true);
    }
  });
  it('retains a native unspent historical coin after pruning without emitting unproved spend edges', async () => {
    const handler = baseHandler('mainnet'); const rpc = new MockRpc((m, p, w) => {
      if (m === 'getblockchaininfo') return { ...handler(m, p, w) as object, pruned: true, pruneheight: 150 };
      if (m === 'getrawtransaction') throw new RpcError(-1, 'Block not available');
      return handler(m, p, w);
    }); const app = await create(rpc, { network: 'mainnet', fetch: explorerFetch({ [`/api/address/${mainAddress}`]: indexed([fundingRow]), [`/api/tx/${PARENT.txid}`]: fundingDetail, [`/api/tx/${PARENT.txid}/hex`]: PARENT_RAW }) });
    const response = await app.inject(post('/api/v1/wallet/sync', { addresses: [mainAddress] })); expect(response.statusCode).toBe(200);
    const result = response.json(); expect(result.complete).toBe(true); expect(result.utxos[0]).toMatchObject({ txid: PARENT.txid, verified: true, classification: 'native', confirmations: 101 }); expect(result.spentOutpoints).toEqual([]);
    expect(result.warnings.join(' ')).toContain('pruned blocks');
  });
  it('caps accumulated confirmed spend graphs and returns an explicit error if the bounded graph exceeds the response byte limit', async () => {
    const transactions = Array.from({ length: 101 }, (_, n) => {
      const inputs = Array.from({ length: 1000 }, (_, i) => `${'bb'.repeat(32)}${uint(i, 4)}00ffffffff`).join('');
      const raw = `02000000fde803${inputs}01${uint(400000 - n, 8)}16${OWN_SCRIPT}00000000`; return { raw, tx: decodeNativeTransaction(raw) };
    }); const handler = baseHandler(); const rpc = new MockRpc((m, p, w) => {
      if (m === 'listtransactions') return transactions.slice(Number(p[2]), Number(p[2]) + 100).map(({ tx }) => ({ txid: tx.txid }));
      if (m === 'gettransaction') { const entry = transactions.find(({ tx }) => tx.txid === p[0]); if (entry) return { hex: entry.raw, confirmations: 1, blockheight: 200, blockhash: TIP }; }
      if (m === 'gettxout') return null;
      return handler(m, p, w);
    }); const app = await create(rpc); const response = await app.inject(post('/api/v1/wallet/sync', { addresses: [address] }));
    expect(response.statusCode).toBe(503); expect(response.json().error.code).toBe('snapshot-too-large'); expect(response.body.length).toBeLessThan(1000);
  });
  it('discovers an incoming transaction before any address-index row or block exists', async () => {
    const externalRaw = rawTx(undefined, undefined, 400200, OTHER_SCRIPT); const external = decodeNativeTransaction(externalRaw);
    const raw = rawTx(external.txid, 0, 400000); const f = setup(raw, { emptyIndex: true, otherRaw: externalRaw }); const app = await f.create();
    const result = (await app.inject(post('/api/v1/wallet/sync', { addresses: [mainAddress] }))).json();
    expect(result).toMatchObject({ complete: true, addresses: [{ address: mainAddress, used: true }] }); expect(result.history).toHaveLength(1); expect(result.history[0]).toMatchObject({ status: 'pending', deltaUnits: '400000', feeUnits: '200' });
    expect(result.utxos[0]).toMatchObject({ txid: f.tx.txid, amountUnits: '400000', confirmations: 0, verified: true });
  });
  it('replaces indexed pending rows instead of double-counting and computes self-transfer as only the fee', async () => {
    const f = setup(rawTx(PARENT.txid, 0, 399800), { indexedPending: true }); const app = await f.create(); const result = (await app.inject(post('/api/v1/wallet/sync', { addresses: [mainAddress] }))).json();
    expect(result.complete).toBe(true); expect(result.history.filter((h: { txid: string }) => h.txid === f.tx.txid)).toEqual([expect.objectContaining({ deltaUnits: '-200', feeUnits: '200', status: 'pending' })]); expect(result.utxos).toHaveLength(1);
  });
  it('detects an outgoing payment without change from the indexed owned prevout', async () => {
    const f = setup(CHILD_RAW); const app = await f.create(); const result = (await app.inject(post('/api/v1/wallet/sync', { addresses: [mainAddress] }))).json();
    expect(result.complete).toBe(true); expect(result.utxos).toEqual([]); expect(result.history.find((h: { txid: string }) => h.txid === CHILD.txid)).toMatchObject({ deltaUnits: '-400000', status: 'pending' });
  });
  it('never reports complete after a relevant prevout or mempool transaction cannot be read', async () => {
    const unavailableParent = 'b'.repeat(64); const f = setup(rawTx(unavailableParent, 0, 100000), { emptyIndex: true }); const app = await f.create(); const result = (await app.inject(post('/api/v1/wallet/sync', { addresses: [mainAddress] }))).json();
    expect(result.complete).toBe(false); expect(result.warnings.join(' ')).toContain('cannot be fully verified');
    const missing = setup(CHILD_RAW, { rpcOverride: (m, p) => { if (m === 'getrawtransaction' && p[0] === CHILD.txid) throw new RpcError(-5, 'gone'); } }); const missingApp = await missing.create();
    expect((await missingApp.inject(post('/api/v1/wallet/sync', { addresses: [mainAddress] }))).json().complete).toBe(false);
  });
  it('bounds current membership and detects a race after overlay even with an unchanged block tip', async () => {
    let reads = 0; const f = setup(CHILD_RAW, { rpcOverride: m => m === 'getrawmempool' ? (++reads === 1 ? [CHILD.txid] : []) : undefined }); const app = await f.create();
    expect((await app.inject(post('/api/v1/wallet/sync', { addresses: [mainAddress] }))).json().warnings.join(' ')).toContain('mempool changed');
    const capped = setup(CHILD_RAW, { limit: 1, rpcOverride: m => m === 'getrawmempool' ? [CHILD.txid, 'f'.repeat(64)] : undefined }); const cappedApp = await capped.create(); const result = (await cappedApp.inject(post('/api/v1/wallet/sync', { addresses: [mainAddress] }))).json();
    expect(result.complete).toBe(false); expect(result.warnings.join(' ')).toContain('Core mempool limit');
  });
  it('does not classify unrelated unsupported transactions, but fails closed for a relevant one', async () => {
    const unrelated = setup(CHILD_RAW, { emptyIndex: true, rpcOverride: (m, p) => m === 'getrawtransaction' && p[0] === CHILD.txid && p[1] === true ? { ...verbose(CHILD_RAW), hex: `${CHILD_RAW}00` } : undefined }); const unrelatedApp = await unrelated.create();
    expect((await unrelatedApp.inject(post('/api/v1/wallet/sync', { addresses: [mainAddress] }))).json()).toMatchObject({ complete: true, utxos: [], history: [] }); expect(unrelated.rpc.calls.some(c => c.method === 'decodeassettransaction')).toBe(false);
    const relevant = setup(rawTx(PARENT.txid, 0, 399800), { rpcOverride: (m, p) => m === 'getrawtransaction' && p[1] === true ? { ...verbose(rawTx(PARENT.txid, 0, 399800)), hex: `${rawTx(PARENT.txid, 0, 399800)}00` } : undefined }); const relevantApp = await relevant.create();
    expect((await relevantApp.inject(post('/api/v1/wallet/sync', { addresses: [mainAddress] }))).json().complete).toBe(false);
  });
  it('shares immutable mempool reads across concurrent syncs and rechecks membership on every request', async () => {
    const f = setup(rawTx(PARENT.txid, 0, 399800)); const app = await f.create(); await Promise.all(Array.from({ length: 3 }, () => app.inject(post('/api/v1/wallet/sync', { addresses: [mainAddress] }))));
    expect(f.rpc.calls.filter(c => c.method === 'getrawtransaction' && c.params[0] === f.tx.txid && c.params[1] === true)).toHaveLength(1); expect(f.rpc.calls.filter(c => c.method === 'getrawmempool')).toHaveLength(6);
    f.rpc.handler = baseHandler('mainnet'); const after = (await app.inject(post('/api/v1/wallet/sync', { addresses: [mainAddress] }))).json(); expect(after.history.some((h: { txid: string }) => h.txid === f.tx.txid)).toBe(false);
  });
});

describe('native validation and deterministic publication', () => {
  it.each(['after-mempool-check', 'before-publication'] as const)('blocks a fresh accepted-tip reorg %s before publishing', async stage => {
    const handler = baseHandler('mainnet'); let changed = false; let chainReads = 0;
    const nextTip = 'c'.repeat(64);
    const rpc = new MockRpc((m, p, w) => {
      if (m === 'getblockchaininfo') {
        if (++chainReads === 4 && stage === 'before-publication') changed = true;
        return { chain: 'tensor', blocks: 200, headers: 201, bestblockhash: changed ? nextTip : TIP, initialblockdownload: false };
      }
      if (m === 'testmempoolaccept' && stage === 'after-mempool-check') changed = true;
      return handler(m, p, w);
    });
    const fetcher = (async input => new URL(String(input)).pathname === '/api/status'
      ? Response.json({ ...indexStatus(), indexed_tip: changed ? nextTip : TIP }) : new Response('{}', { status: 404 })) as typeof fetch;
    const app = await create(rpc, { network: 'mainnet', fetch: fetcher, minConfirmations: 2 });
    const result = await app.inject(post('/api/v1/tx/broadcast', { rawHex: CHILD_RAW }));
    expect(result.statusCode).toBe(503); expect(result.json().error.code).toBe('stale-outpoint');
    expect(rpc.calls.filter(c => c.method === 'testmempoolaccept')).toHaveLength(1);
    expect(rpc.calls.some(c => c.method === 'sendrawtransaction')).toBe(false);
  });
  it('does not invalidate verified inputs when only pending header count grows during validation', async () => {
    const handler = baseHandler('mainnet'); let headers = 201;
    const rpc = new MockRpc((m, p, w) => {
      if (m === 'getblockchaininfo') return { chain: 'tensor', blocks: 200, headers, bestblockhash: TIP, initialblockdownload: false };
      if (m === 'testmempoolaccept') headers++;
      return handler(m, p, w);
    });
    const fetcher = (async input => new URL(String(input)).pathname === '/api/status'
      ? Response.json({ ...validationWaitStatus(), core_headers: headers }) : new Response('{}', { status: 404 })) as typeof fetch;
    const app = await create(rpc, { network: 'mainnet', fetch: fetcher, minConfirmations: 2 });
    const result = await app.inject(post('/api/v1/tx/validate', { rawHex: CHILD_RAW }));
    expect(result.statusCode).toBe(200); expect(result.json()).toEqual({ txid: CHILD.txid, allowed: true });
  });
  it('still verifies every native input and Core policy while unaccepted headers wait', async () => {
    const handler = baseHandler('mainnet');
    const rpc = new MockRpc((m, p, w) => m === 'getblockchaininfo' ? { chain: 'tensor', blocks: 200, headers: 201, bestblockhash: TIP, initialblockdownload: false } : handler(m, p, w));
    const fetcher = (async input => new URL(String(input)).pathname === '/api/status'
      ? Response.json(validationWaitStatus()) : new Response('{}', { status: 404 })) as typeof fetch;
    const app = await create(rpc, { network: 'mainnet', fetch: fetcher, minConfirmations: 2 });
    const result = await app.inject(post('/api/v1/tx/validate', { rawHex: CHILD_RAW }));
    expect(result.statusCode).toBe(200); expect(result.json()).toEqual({ txid: CHILD.txid, allowed: true });
    expect(rpc.calls.some(c => c.method === 'gettxout' && c.params[0] === PARENT.txid && c.params[1] === 0 && c.params[2] === true)).toBe(true);
    expect(rpc.calls.some(c => c.method === 'decodeassettransaction')).toBe(true);
    expect(rpc.calls.find(c => c.method === 'testmempoolaccept')?.params[0]).toEqual([CHILD_RAW]);
    expect(rpc.calls.some(c => c.method === 'sendrawtransaction')).toBe(false);
  });
  it('checks parent, current policy, exact fee, then broadcasts same raw bytes', async () => {
    const rpc = new MockRpc(baseHandler()); const app = await create(rpc); const response = await app.inject(post('/api/v1/tx/broadcast', { rawHex: CHILD_RAW }));
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ txid: CHILD.txid, status: 'accepted' });
    expect(rpc.calls.find(c => c.method === 'sendrawtransaction')?.params).toEqual([CHILD_RAW, '0.00100000']);
    expect(rpc.calls.find(c => c.method === 'testmempoolaccept')?.params[0]).toEqual([CHILD_RAW]);
  });
  it('returns already-known without republishing', async () => {
    const handler = baseHandler(); const rpc = new MockRpc((m, p, w) => m === 'getmempoolentry' ? { vsize: CHILD.vsize } : handler(m, p, w));
    const app = await create(rpc); expect((await app.inject(post('/api/v1/tx/broadcast', { rawHex: CHILD_RAW }))).json()).toEqual({ txid: CHILD.txid, status: 'already-known' });
    expect(rpc.calls.some(c => c.method === 'sendrawtransaction')).toBe(false);
  });
  it('recognizes confirmed mainnet retry with txindex disabled using a canonical block hint', async () => {
    const handler = baseHandler('mainnet'); const rpc = new MockRpc((m, p, w) => {
      if (m === 'getrawtransaction' && p[0] === CHILD.txid && p[2] === TIP) return { txid: CHILD.txid, confirmations: 20, in_active_chain: true };
      return handler(m, p, w);
    });
    const app = await create(rpc, { network: 'mainnet', fetch: explorerFetch({ [`/api/tx/${CHILD.txid}`]: { transaction: { txid: CHILD.txid, block_height: 181, block_hash: TIP } } }) });
    expect((await app.inject(post('/api/v1/tx/broadcast', { rawHex: CHILD_RAW }))).json()).toEqual({ txid: CHILD.txid, status: 'already-known' });
    expect(rpc.calls.some(c => c.method === 'sendrawtransaction')).toBe(false);
    expect(rpc.calls.some(c => c.method === 'getrawtransaction' && c.params[2] === TIP)).toBe(true);
  });
  it('uses a current submitted output as retry proof when the original block is pruned', async () => {
    const handler = baseHandler('mainnet'); const rpc = new MockRpc((m, p, w) => {
      if (m === 'gettxout' && p[0] === CHILD.txid) return { confirmations: 10000, coinbase: false, value: '0.00399800', scriptPubKey: { hex: OTHER_SCRIPT } };
      return handler(m, p, w);
    });
    const app = await create(rpc, { network: 'mainnet', fetch: explorerFetch({}) });
    expect((await app.inject(post('/api/v1/tx/broadcast', { rawHex: CHILD_RAW }))).json()).toEqual({ txid: CHILD.txid, status: 'already-known' });
    expect(rpc.calls.some(c => c.method === 'sendrawtransaction')).toBe(false);
  });
  it('preserves unknown outcome when all submitted outputs and parents are spent or pruned', async () => {
    const handler = baseHandler('mainnet'); const rpc = new MockRpc((m, p, w) => m === 'gettxout' ? null : handler(m, p, w));
    const app = await create(rpc, { network: 'mainnet', fetch: explorerFetch({}) });
    const response = await app.inject(post('/api/v1/tx/broadcast', { rawHex: CHILD_RAW }));
    expect(response.statusCode).toBe(503); expect(response.json().error.code).toBe('transaction-state-unknown');
    expect(rpc.calls.some(c => c.method === 'sendrawtransaction')).toBe(false);
  });
  it('rejects excessive absolute fee before mempool validation or publication', async () => {
    const rpc = new MockRpc(baseHandler()); const app = await create(rpc, { maximumFeeUnits: '100' });
    const response = await app.inject(post('/api/v1/tx/validate', { rawHex: CHILD_RAW })); expect(response.json()).toMatchObject({ allowed: false, canDiscard: true });
    expect(rpc.calls.some(c => c.method === 'testmempoolaccept' || c.method === 'sendrawtransaction')).toBe(false);
  });
  it('never offers discard when an input becomes spent after initial fee rejection', async () => {
    const handler = baseHandler(); let checks = 0; const rpc = new MockRpc((m, p, w) => m === 'gettxout' && ++checks > 1 ? null : handler(m, p, w));
    const app = await create(rpc, { maximumFeeUnits: '100' });
    expect((await app.inject(post('/api/v1/tx/validate', { rawHex: CHILD_RAW }))).json()).toMatchObject({ allowed: false, canDiscard: false });
  });
  it('never offers discard when the submitted transaction appears in mempool during proof', async () => {
    const handler = baseHandler(); let checks = 0; const rpc = new MockRpc((m, p, w) => m === 'getmempoolentry' && ++checks > 1 ? { vsize: CHILD.vsize } : handler(m, p, w));
    const app = await create(rpc, { maximumFeeUnits: '100' });
    expect((await app.inject(post('/api/v1/tx/validate', { rawHex: CHILD_RAW }))).json()).toMatchObject({ allowed: false, canDiscard: false });
  });
  it('never offers discard across an unrelated mempool race', async () => {
    const handler = baseHandler(); let checks = 0; const rpc = new MockRpc((m, p, w) => m === 'getrawmempool' ? (++checks === 1 ? [] : ['b'.repeat(64)]) : handler(m, p, w));
    const app = await create(rpc, { maximumFeeUnits: '100' });
    expect((await app.inject(post('/api/v1/tx/validate', { rawHex: CHILD_RAW }))).json()).toMatchObject({ allowed: false, canDiscard: false });
  });
  it('never offers discard across a chain tip race or unknown native classification', async () => {
    const handler = baseHandler(); let checks = 0; const rpc = new MockRpc((m, p, w) => {
      if (m === 'getblockchaininfo' && ++checks >= 3) return { chain: 'regtest', blocks: 201, headers: 201, bestblockhash: 'b'.repeat(64), initialblockdownload: false };
      return handler(m, p, w);
    });
    const app = await create(rpc, { maximumFeeUnits: '100' });
    expect((await app.inject(post('/api/v1/tx/validate', { rawHex: CHILD_RAW }))).json()).toMatchObject({ allowed: false, canDiscard: false });
    let decodeCalls = 0; const unknownRpc = new MockRpc((m, p, w) => {
      if (m === 'decodeassettransaction' && ++decodeCalls >= 3) throw new RpcError(-1, 'decoder unavailable'); return handler(m, p, w);
    });
    const unknownApp = await create(unknownRpc, { maximumFeeUnits: '100' });
    expect((await unknownApp.inject(post('/api/v1/tx/validate', { rawHex: CHILD_RAW }))).json()).toMatchObject({ allowed: false, canDiscard: false });
  });
  it('rejects immature coinbase inputs', async () => {
    const handler = baseHandler(); const rpc = new MockRpc((m, p, w) => m === 'gettxout' ? { bestblock: TIP, confirmations: 99, value: '0.00400000', coinbase: true, scriptPubKey: { hex: OWN_SCRIPT } } : handler(m, p, w));
    const app = await create(rpc); expect((await app.inject(post('/api/v1/tx/validate', { rawHex: CHILD_RAW }))).json()).toMatchObject({ allowed: false, reason: 'An input is unsupported, unconfirmed, or immature.' });
  });
  it('forbids extension flags and trailing bytes before publication', async () => {
    const rpc = new MockRpc(baseHandler()); const app = await create(rpc);
    for (const rawHex of [`020000000002${CHILD_RAW.slice(8)}`, `${CHILD_RAW}00`]) expect((await app.inject(post('/api/v1/tx/broadcast', { rawHex }))).statusCode).toBe(422);
    expect(rpc.calls.some(c => c.method === 'sendrawtransaction')).toBe(false);
  });
  it('reports unknown outcome without a second send', async () => {
    const handler = baseHandler(); const rpc = new MockRpc((m, p, w) => { if (m === 'sendrawtransaction') throw new Error('network timeout with secret credentials'); return handler(m, p, w); });
    const app = await create(rpc); const response = await app.inject(post('/api/v1/tx/broadcast', { rawHex: CHILD_RAW }));
    expect(response.statusCode).toBe(503); expect(response.json().error.code).toBe('broadcast-outcome-unknown'); expect(response.body).not.toContain('secret credentials'); expect(rpc.calls.filter(c => c.method === 'sendrawtransaction')).toHaveLength(1);
  });
  it('uses exact decimal unit conversion and rounds dynamic policy up', async () => {
    expect(coinUnits('1e-8')).toBe(1n); expect(coinUnits('0.12345678')).toBe(12345678n); expect(() => coinUnits('0.000000001')).toThrow();
    const handler = baseHandler(); const rpc = new MockRpc((m, p, w) => m === 'getmempoolinfo' ? { minrelaytxfee: '0.00001001', mempoolminfee: '0.00002001' } : handler(m, p, w));
    const app = await create(rpc); expect((await app.inject('/api/v1/fees')).json()).toMatchObject({ relayFloorUnitsPerVbyte: '2', mempoolFloorUnitsPerVbyte: '3', suggestedRate: '3' });
  });
});
