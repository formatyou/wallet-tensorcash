import { describe, expect, it } from 'vitest';
import { Address } from '@scure/btc-signer';
import { hex } from '@scure/base';
import { MAINNET_GENESIS, resolveConfig } from './config';
import { RpcError } from './errors';
import { Gateway } from './gateway';
import type { Rpc } from './rpc';
import { decodeNativeTransaction } from '../src/core/raw';
import { networkConfig } from '../src/core/network';

// Call-cost regression harness: how many Core RPC calls and explorer fetches one
// `POST /api/v1/wallet/sync` costs on the mainnet path (unpruned Core, txindex=0).
// A = watched addresses, N = confirmed wallet transactions, U = unspent outputs.
// "cold" is the first sync of a new gateway process, "warm" the same sync repeated.
// The route handler only validates the body and calls Gateway.sync, so the gateway
// is driven directly: building the app per scenario costs more than the syncs.
//
// BASELINE holds the measured counts and is asserted as an upper bound only. A
// change that makes a sync cheaper lowers the numbers here; nothing may raise
// them. A method or route that is not listed is bounded by 0. Run with
// SYNC_COST_REPORT=1 to print the current counts in this shape.
interface Cost { rpc: number; explorer: number; methods: Record<string, number>; routes: Record<string, number>; }
const BASELINE = {
  'fresh wallet, A=50': {
    cold: { rpc: 58, explorer: 52, methods: { getblockchaininfo: 2, getblockhash: 2, getblockheader: 2, getrawmempool: 2, validateaddress: 50 }, routes: { status: 2, address: 50 } },
    warm: { rpc: 58, explorer: 52, methods: { getblockchaininfo: 2, getblockhash: 2, getblockheader: 2, getrawmempool: 2, validateaddress: 50 }, routes: { status: 2, address: 50 } },
  },
  'fresh wallet, A=100': {
    cold: { rpc: 108, explorer: 102, methods: { getblockchaininfo: 2, getblockhash: 2, getblockheader: 2, getrawmempool: 2, validateaddress: 100 }, routes: { status: 2, address: 100 } },
    warm: { rpc: 108, explorer: 102, methods: { getblockchaininfo: 2, getblockhash: 2, getblockheader: 2, getrawmempool: 2, validateaddress: 100 }, routes: { status: 2, address: 100 } },
  },
  'A=100, N=50, U=10': {
    cold: { rpc: 368, explorer: 152, methods: { getblockchaininfo: 2, getblockhash: 52, getblockheader: 2, getrawmempool: 2, validateaddress: 100, getrawtransaction: 100, decodeassettransaction: 60, gettxout: 50 }, routes: { status: 2, address: 100, tx: 50 } },
    warm: { rpc: 318, explorer: 152, methods: { getblockchaininfo: 2, getblockhash: 52, getblockheader: 2, getrawmempool: 2, validateaddress: 100, getrawtransaction: 50, decodeassettransaction: 60, gettxout: 50 }, routes: { status: 2, address: 100, tx: 50 } },
  },
  // More transactions than the 256-entry raw cache holds: it thrashes, so the warm sync saves almost nothing.
  'A=100, N=300, U=10': {
    cold: { rpc: 1628, explorer: 404, methods: { getblockchaininfo: 2, getblockhash: 302, getblockheader: 2, getrawmempool: 2, validateaddress: 100, getrawtransaction: 610, decodeassettransaction: 310, gettxout: 300 }, routes: { status: 2, address: 102, tx: 300 } },
    warm: { rpc: 1618, explorer: 404, methods: { getblockchaininfo: 2, getblockhash: 302, getblockheader: 2, getrawmempool: 2, validateaddress: 100, getrawtransaction: 600, decodeassettransaction: 310, gettxout: 300 }, routes: { status: 2, address: 102, tx: 300 } },
  },
  'A=100, N=50, U=10, one pending spend of a wallet coin': {
    cold: { rpc: 370, explorer: 152, methods: { getblockchaininfo: 2, getblockhash: 52, getblockheader: 2, getrawmempool: 2, validateaddress: 100, getrawtransaction: 101, decodeassettransaction: 61, gettxout: 49, getmempoolentry: 1 }, routes: { status: 2, address: 100, tx: 50 } },
    warm: { rpc: 319, explorer: 152, methods: { getblockchaininfo: 2, getblockhash: 52, getblockheader: 2, getrawmempool: 2, validateaddress: 100, getrawtransaction: 50, decodeassettransaction: 61, gettxout: 49, getmempoolentry: 1 }, routes: { status: 2, address: 100, tx: 50 } },
  },
  // Every mempool transaction is read once per gateway process, whoever it belongs to.
  'gateway restart, fresh wallet, A=100, mempool of 360 unrelated transactions': {
    cold: { rpc: 468, explorer: 102, methods: { getblockchaininfo: 2, getblockhash: 2, getblockheader: 2, getrawmempool: 2, validateaddress: 100, getrawtransaction: 360 }, routes: { status: 2, address: 100 } },
    warm: { rpc: 108, explorer: 102, methods: { getblockchaininfo: 2, getblockhash: 2, getblockheader: 2, getrawmempool: 2, validateaddress: 100 }, routes: { status: 2, address: 100 } },
  },
} satisfies Record<string, { cold: Cost; warm: Cost }>;
interface Scenario { addresses: number; transactions: number; unspent: number; mempool: number; pendingSpend?: boolean; }
const SCENARIOS: Record<keyof typeof BASELINE, Scenario> = {
  'fresh wallet, A=50': { addresses: 50, transactions: 0, unspent: 0, mempool: 0 },
  'fresh wallet, A=100': { addresses: 100, transactions: 0, unspent: 0, mempool: 0 },
  'A=100, N=50, U=10': { addresses: 100, transactions: 50, unspent: 10, mempool: 0 },
  'A=100, N=300, U=10': { addresses: 100, transactions: 300, unspent: 10, mempool: 0 },
  'A=100, N=50, U=10, one pending spend of a wallet coin': { addresses: 100, transactions: 50, unspent: 10, mempool: 0, pendingSpend: true },
  'gateway restart, fresh wallet, A=100, mempool of 360 unrelated transactions': { addresses: 100, transactions: 0, unspent: 0, mempool: 360 },
};

const HEIGHT = 200;
const TIP = 'a'.repeat(64);
const FOREIGN_SCRIPT = `0014${'f'.repeat(40)}`;
const now = () => Math.floor(Date.now() / 1000);
const uint = (n: number, bytes: number) => { const b = Buffer.alloc(bytes); if (bytes === 4) b.writeUInt32LE(n); else b.writeBigUInt64LE(BigInt(n)); return b.toString('hex'); };
function rawTx(inputTxid: string, vout: number, amount: number, scriptHex: string): string {
  return `0200000001${Buffer.from(inputTxid, 'hex').reverse().toString('hex')}${uint(vout, 4)}00ffffffff01${uint(amount, 8)}${(scriptHex.length / 2).toString(16).padStart(2, '0')}${scriptHex}00000000`;
}
// Real bech32 P2WPKH addresses, so the harness survives a switch to local address decoding.
function walletAddress(index: number) {
  const scriptHex = `0014${(index + 1).toString(16).padStart(40, '0')}`;
  return { scriptHex, address: Address(networkConfig('mainnet').bitcoin).encode({ type: 'wpkh', hash: hex.decode(scriptHex.slice(4)) }) };
}
const blockHash = (height: number) => height === 0 ? MAINNET_GENESIS : height === HEIGHT ? TIP : height.toString(16).padStart(64, '0');
const blockHeight = (hash: string) => hash === TIP ? HEIGHT : hash === MAINNET_GENESIS ? 0 : Number.parseInt(hash, 16);
function asset(raw: string) {
  const tx = decodeNativeTransaction(raw);
  return { txid: tx.txid, asset_summary: { has_assets: false, has_icu: false }, vout: tx.outputs.map(o => ({ n: o.vout, value: (Number(o.amountUnits) / 1e8).toFixed(8), scriptPubKey: { hex: o.scriptHex } })) };
}
function verbose(raw: string) {
  const tx = decodeNativeTransaction(raw);
  return { txid: tx.txid, hex: raw, vin: tx.inputs.map(i => ({ txid: i.txid, vout: i.vout })), vout: asset(raw).vout };
}
type Handler = (method: string, params: unknown[]) => unknown;
class MockRpc implements Rpc {
  calls: { method: string; params: unknown[] }[] = [];
  constructor(public handler: Handler) {}
  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> { this.calls.push({ method, params }); return await this.handler(method, params) as T; }
}
const tally = (values: string[]) => values.reduce<Record<string, number>>((counts, value) => ({ ...counts, [value]: (counts[value] ?? 0) + 1 }), {});
const sum = (counts: Record<string, number>) => Object.values(counts).reduce((total, count) => total + count, 0);

// A mocked Core and explorer that agree on one chain: N single-output payments to
// the first address (the first U still unspent), plus a mempool.
function world(scenario: Scenario) {
  const tipTime = now();
  const wallet = Array.from({ length: scenario.addresses }, (_, index) => walletAddress(index));
  const scripts = new Map(wallet.map(entry => [entry.address, entry.scriptHex]));
  const confirmed = new Map(Array.from({ length: scenario.transactions }, (_, n) => {
    const raw = rawTx('c'.repeat(63) + (n % 10), n, 1000 + n, wallet[0].scriptHex); const tx = decodeNativeTransaction(raw);
    return [tx.txid, { raw, tx, height: 100 + (n % 100) }] as const;
  }));
  const unspent = new Set([...confirmed.keys()].slice(0, scenario.unspent));
  const mempool = new Map(Array.from({ length: scenario.mempool }, (_, n) => { const raw = rawTx('d'.repeat(64), n, 5000 + n, FOREIGN_SCRIPT); return [decodeNativeTransaction(raw).txid, raw] as const; }));
  if (scenario.pendingSpend) {
    const [spentTxid] = unspent; const raw = rawTx(spentTxid, 0, 900, FOREIGN_SCRIPT);
    mempool.set(decodeNativeTransaction(raw).txid, raw); unspent.delete(spentTxid);
  }
  const rpc = new MockRpc((method, params) => {
    switch (method) {
      case 'getblockchaininfo': return { chain: 'tensor', blocks: HEIGHT, headers: HEIGHT, bestblockhash: TIP, initialblockdownload: false, pruned: false };
      case 'getblockhash': return blockHash(params[0] as number);
      case 'getblockheader': { const height = blockHeight(params[0] as string); return { hash: params[0], height, time: tipTime - (HEIGHT - height) * 600, ...(height > 0 ? { previousblockhash: blockHash(height - 1) } : {}) }; }
      case 'getrawmempool': return [...mempool.keys()];
      case 'validateaddress': { const scriptHex = scripts.get(params[0] as string); return scriptHex ? { isvalid: true, address: params[0], scriptPubKey: scriptHex } : { isvalid: false }; }
      case 'getrawtransaction': {
        const [txid, verbosity, block] = params as [string, boolean, string | undefined];
        const pooled = mempool.get(txid); if (pooled) return verbosity ? verbose(pooled) : pooled;
        // txindex=0: Core serves a confirmed transaction only together with its block hash.
        const tx = confirmed.get(txid); if (!tx || block !== blockHash(tx.height)) throw new RpcError(-5, 'No such mempool or blockchain transaction');
        return verbosity ? { ...verbose(tx.raw), in_active_chain: true, blockhash: block, confirmations: HEIGHT - tx.height + 1 } : tx.raw;
      }
      case 'decodeassettransaction': return asset(params[0] as string);
      case 'gettxout': {
        const tx = confirmed.get(params[0] as string); if (!tx || params[1] !== 0 || !unspent.has(tx.tx.txid)) return null;
        return { bestblock: TIP, confirmations: HEIGHT - tx.height + 1, value: asset(tx.raw).vout[0].value, coinbase: false, scriptPubKey: { hex: wallet[0].scriptHex } };
      }
      case 'getmempoolentry': if (mempool.has(params[0] as string)) return { time: tipTime }; throw new RpcError(-5, 'Transaction not in mempool');
      default: throw new Error(`Unexpected mock RPC ${method}`);
    }
  });
  const fetches: string[] = [];
  const indexStatus = () => ({ ready: true, core_online: true, initial_block_download: false, indexed_height: HEIGHT, indexed_tip: TIP, lag_blocks: 0, checked_at: now() });
  const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
  const explorer = (async input => {
    const url = new URL(String(input)); const [, route, id, extra] = url.pathname.split('/').slice(1);
    fetches.push(extra === undefined && ['status', 'address', 'tx'].includes(route) ? route : url.pathname);
    if (url.pathname === '/api/status') return json(indexStatus());
    if (route === 'address' && extra === undefined) {
      const rows = id === wallet[0].address ? [...confirmed.values()].map(({ tx, height }) => ({ txid: tx.txid, block_height: height, block_hash: blockHash(height), delta_sats: Number(tx.outputs[0].amountUnits), fee_sats: 100, timestamp: tipTime - (HEIGHT - height) * 600 })) : [];
      const page = Number(url.searchParams.get('page')); const size = Number(url.searchParams.get('page_size'));
      return json({ status: indexStatus(), transactions: rows.slice((page - 1) * size, page * size), pagination: { page, has_next: page * size < rows.length, total: rows.length, total_pages: Math.ceil(rows.length / size) } });
    }
    const tx = route === 'tx' && extra === undefined ? confirmed.get(id) : undefined; if (!tx) return new Response('{}', { status: 404 });
    return json({ transaction: { txid: tx.tx.txid, is_coinbase: false, block_height: tx.height, block_hash: blockHash(tx.height), output_count: 1, outputs: [{ address: wallet[0].address, vout_index: 0, value_sats: Number(tx.tx.outputs[0].amountUnits), script_hex: wallet[0].scriptHex }] } });
  }) as typeof fetch;
  return {
    rpc, explorer, addresses: wallet.map(entry => entry.address),
    // What a complete sync of this wallet returns; proves the measured request did the whole job.
    expected: { complete: true, utxos: unspent.size, history: confirmed.size + (scenario.pendingSpend ? 1 : 0) },
    reset() { rpc.calls.length = 0; fetches.length = 0; },
    cost(): Cost { const methods = tally(rpc.calls.map(call => call.method)); const routes = tally(fetches); return { rpc: sum(methods), explorer: sum(routes), methods, routes }; },
  };
}

describe('wallet sync call cost', () => {
  it.each(Object.keys(SCENARIOS) as (keyof typeof SCENARIOS)[])('stays within the measured Core RPC and explorer calls: %s', async name => {
    const mock = world(SCENARIOS[name]);
    const gateway = new Gateway(resolveConfig({ network: 'mainnet', rpcUrl: 'http://127.0.0.1:39242', allowedOrigins: ['https://wallet.example'], fetch: mock.explorer }), mock.rpc);
    // The client reads /network before every sync; that read pays the once-per-tip block-timing calls, which are not sync cost.
    expect(await gateway.network()).toMatchObject({ ready: true, height: HEIGHT, averageBlockSeconds: 600 });
    for (const phase of ['cold', 'warm'] as const) {
      mock.reset();
      const snapshot = await gateway.sync(mock.addresses); const cost = mock.cost();
      if (process.env.SYNC_COST_REPORT) console.log(`'${name}' ${phase}: ${JSON.stringify(cost).replace(/"/g, '')}`);
      expect({ complete: snapshot.complete, utxos: snapshot.utxos.length, history: snapshot.history.length }).toEqual(mock.expected);
      const bound: Cost = BASELINE[name][phase]; const measured = `${name} (${phase}) measured ${JSON.stringify(cost)}`;
      expect(sum(bound.methods), 'baseline RPC total equals its per-method breakdown').toBe(bound.rpc);
      expect(sum(bound.routes), 'baseline explorer total equals its per-route breakdown').toBe(bound.explorer);
      expect(cost.rpc, measured).toBeLessThanOrEqual(bound.rpc);
      expect(cost.explorer, measured).toBeLessThanOrEqual(bound.explorer);
      for (const [method, count] of Object.entries(cost.methods)) expect(count, `${method}: ${measured}`).toBeLessThanOrEqual(bound.methods[method] ?? 0);
      for (const [route, count] of Object.entries(cost.routes)) expect(count, `${route}: ${measured}`).toBeLessThanOrEqual(bound.routes[route] ?? 0);
    }
  });
});
