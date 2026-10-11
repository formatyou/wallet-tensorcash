import { describe, expect, it } from 'vitest';
import { Gateway } from './gateway';
import { MAINNET_GENESIS, resolveConfig } from './config';
import type { Rpc } from './rpc';
import { indexFetch, isoAgo } from './test-index';

const TIP = 'a'.repeat(64);
const now = () => Math.floor(Date.now() / 1000);
const covered = (blocks: number, transactions = blocks, addresses = blocks) => ({ coverage: {
  blocks: { scope: 'chain_wide', state: 'complete', through_height: blocks }, transactions: { scope: 'chain_wide', state: 'complete', through_height: transactions }, addresses: { scope: 'chain_wide', state: 'complete', through_height: addresses } } });
function fixture(options: { core?: Record<string, unknown>; status?: Record<string, unknown>; statusTip?: { height: number; hash: string }; time?: number; unavailable?: boolean; raw?: string } = {}) {
  const calls: string[] = [];
  const rpc: Rpc = { async call<T>(method: string, params: unknown[] = []): Promise<T> {
    calls.push(method);
    if (method === 'getblockchaininfo') return { chain: 'tensor', blocks: 200, headers: 200, bestblockhash: TIP, initialblockdownload: false, ...options.core } as T;
    if (method === 'getblockhash') return (params[0] === 0 ? MAINNET_GENESIS : TIP) as T;
    if (method === 'getblockheader') return { time: options.time ?? now() } as T;
    throw new Error(`Unexpected RPC ${method}`);
  } };
  const index = indexFetch({ status: options.status, ...(options.statusTip ? { statusTip: () => options.statusTip! } : {}) });
  const fetcher = (async (input, init) => {
    if (options.unavailable) throw new Error('offline');
    if (options.raw !== undefined) return new Response(options.raw, { headers: { 'x-chain-height': '200', 'x-chain-hash': TIP } });
    return index(input, init);
  }) as typeof fetch;
  const gateway = new Gateway(resolveConfig({ network: 'mainnet', rpcUrl: 'http://127.0.0.1:19443', allowedOrigins: ['https://wallet.example'], rpc, fetch: fetcher }), rpc);
  return { gateway, calls };
}

describe('network readiness diagnostics retain strict freshness and chain gates', () => {
  it('omits the optional blocked reason when all readiness gates pass', async () => {
    const info = await fixture().gateway.network();
    expect(info.ready).toBe(true); expect(info.readinessReason).toBeUndefined();
  });
  it.each([2600, 7201, 86400, 7 * 86400])('keeps a freshly observed accepted chain usable after a %i-second block gap', async tipAge => {
    for (const headers of [200, 201]) {
      const info = await fixture({ time: now() - tipAge, core: { headers }, status: { observed_header_height: headers } }).gateway.network();
      expect(info).toMatchObject({ ready: true, height: 200, indexedHeight: 200, tipHash: TIP });
      expect(info.readinessReason).toBeUndefined();
    }
  });
  it.each([
    ['index not ready while new headers await validation', { core: { headers: 201 }, status: { sync_state: 'syncing' } }, 'block-validation'],
    ['index not ready without pending headers', { status: { sync_state: 'syncing' } }, 'index-sync'],
    ['initial node sync', { core: { initialblockdownload: true, headers: 300 } }, 'node-sync'],
    ['unexpected node height', { core: { headers: 199 } }, 'node-sync'],
    ['index node in initial sync', { status: { core_initial_block_download: true } }, 'node-sync'],
    ['index lag', { statusTip: { height: 199, hash: 'b'.repeat(64) }, status: { observed_core_height: 199, ...covered(199) } }, 'index-sync'],
    ['index fork', { statusTip: { height: 200, hash: 'b'.repeat(64) } }, 'index-sync'],
    ['index ahead', { statusTip: { height: 201, hash: 'b'.repeat(64) }, status: { observed_core_height: 201, ...covered(201) } }, 'index-sync'],
    ['partial address coverage', { status: covered(200, 200, 199) }, 'index-sync'],
    ['partial address scope', { status: { coverage: { ...covered(200).coverage, addresses: { scope: 'from_height', state: 'complete', through_height: 200 } } } }, 'index-sync'],
    ['incomplete transaction coverage', { status: { coverage: { ...covered(200).coverage, transactions: { scope: 'chain_wide', state: 'indexing', through_height: 200 } } } }, 'index-sync'],
    ['index node behind its own index', { status: { observed_core_height: 199 } }, 'index-sync'],
    ['index unavailable', { unavailable: true }, 'index-unavailable'],
    ['index serves another network', { status: { network: 'testnet' } }, 'index-unavailable'],
    ['missing coverage', { status: { coverage: {} } }, 'index-unavailable'],
    ['invalid poll time', { status: { last_core_poll_at: 'invalid' } }, 'index-unavailable'],
    ['response without chain tip headers', { raw: JSON.stringify({ data: {} }) }, 'index-unavailable'],
    ['invalid JSON', { raw: 'not json' }, 'index-unavailable'],
    ['stale index poll', { status: { last_core_poll_at: isoAgo(31) } }, 'stale-data'],
    ['future index poll', { status: { last_core_poll_at: isoAgo(-32) } }, 'stale-data'],
    ['invalid zero node timestamp', { time: 0 }, 'stale-data'],
    ['future node tip', { time: now() + 7202 }, 'stale-data'],
  ] as const)('describes %s and refuses transfer validation before touching its inputs', async (_name, options, reason) => {
    const { gateway, calls } = fixture(options);
    expect(await gateway.network()).toMatchObject({ ready: false, readinessReason: reason });
    await expect(gateway.validate('00'.repeat(20))).rejects.toMatchObject({ code: 'network-not-ready' });
    expect(calls).not.toContain('testmempoolaccept'); expect(calls).not.toContain('gettxout');
  });
  it('uses the accepted Core tip when newer headers await validation and the exact index is healthy', async () => {
    const info = await fixture({ core: { headers: 204 } }).gateway.network();
    expect(info).toMatchObject({ ready: true, height: 200, indexedHeight: 200, tipHash: TIP, pendingValidationBlocks: 4 });
    expect(info.readinessReason).toBeUndefined();
  });
  it('still requires the index to catch up to the accepted Core tip while new headers wait', async () => {
    const info = await fixture({ core: { headers: 201 }, statusTip: { height: 199, hash: 'b'.repeat(64) }, status: { observed_core_height: 199, ...covered(199) } }).gateway.network();
    expect(info).toMatchObject({ ready: false, indexedHeight: 199, readinessReason: 'index-sync' });
  });
  it.each([
    { statusTip: { height: 201, hash: 'b'.repeat(64) } }, { statusTip: { height: 200, hash: 'b'.repeat(64) } },
    { status: { last_core_poll_at: isoAgo(31) } }, { status: { core_initial_block_download: true } }, { status: { sync_state: 'syncing' } },
    { core: { initialblockdownload: true } }, { time: now() + 7202 },
  ])('never lets pending validation bypass an index, identity, initial sync or freshness gate', async options => {
    const { gateway, calls } = fixture({ ...options, core: { headers: 205, ...('core' in options ? options.core : {}) } });
    expect((await gateway.network()).ready).toBe(false);
    await expect(gateway.validate('00'.repeat(20))).rejects.toMatchObject({ code: 'network-not-ready' });
    expect(calls).not.toContain('testmempoolaccept');
  });
});
