import { describe, expect, it } from 'vitest';
import { Gateway } from './gateway';
import { MAINNET_GENESIS, resolveConfig } from './config';
import type { Rpc } from './rpc';

const TIP = 'a'.repeat(64);
const now = () => Math.floor(Date.now() / 1000);
function fixture(options: { core?: Record<string, unknown>; index?: Record<string, unknown>; time?: number; unavailable?: boolean } = {}) {
  const calls: string[] = [];
  const rpc: Rpc = { async call<T>(method: string, params: unknown[] = []): Promise<T> {
    calls.push(method);
    if (method === 'getblockchaininfo') return { chain: 'tensor', blocks: 200, headers: 200, bestblockhash: TIP, initialblockdownload: false, ...options.core } as T;
    if (method === 'getblockhash') return (params[0] === 0 ? MAINNET_GENESIS : TIP) as T;
    if (method === 'getblockheader') return { time: options.time ?? now() } as T;
    throw new Error(`Unexpected RPC ${method}`);
  } };
  const fetcher = (async () => {
    if (options.unavailable) throw new Error('offline');
    return new Response(JSON.stringify({ ready: true, core_online: true, initial_block_download: false,
      indexed_height: 200, indexed_tip: TIP, lag_blocks: 0, checked_at: now(), ...options.index }));
  }) as typeof fetch;
  const gateway = new Gateway(resolveConfig({ network: 'mainnet', rpcUrl: 'http://127.0.0.1:19443', allowedOrigins: ['https://wallet.example'], rpc, fetch: fetcher }), rpc);
  return { gateway, calls };
}

describe('network readiness diagnostics retain strict freshness and chain gates', () => {
  it('omits the optional blocked reason when all readiness gates pass', async () => {
    const info = await fixture().gateway.network();
    expect(info.ready).toBe(true); expect(info.readinessReason).toBeUndefined();
  });
  it.each([
    ['ambiguous index readiness while new headers await validation', { core: { headers: 201 }, index: { ready: false } }, 'block-validation'],
    ['initial node sync', { core: { initialblockdownload: true, headers: 300 } }, 'node-sync'],
    ['unexpected node height', { core: { headers: 199 } }, 'node-sync'],
    ['index lag', { index: { ready: false, indexed_height: 199, lag_blocks: 1 } }, 'index-sync'],
    ['index fork', { index: { indexed_tip: 'b'.repeat(64) } }, 'index-sync'],
    ['index ahead', { index: { indexed_height: 201 } }, 'index-sync'],
    ['index unavailable', { unavailable: true }, 'index-unavailable'],
    ['index has lost its node', { index: { core_online: false } }, 'index-unavailable'],
    ['invalid index data', { index: { checked_at: 'invalid' } }, 'index-unavailable'],
    ['stale index check', { index: { checked_at: now() - 31 } }, 'stale-data'],
    ['future index check', { index: { checked_at: now() + 32 } }, 'stale-data'],
    ['stale node tip', { time: now() - 7201 }, 'stale-data'],
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
  it('uses an explicitly verified accepted-tip index while its generic ready flag waits for block validation', async () => {
    const info = await fixture({ core: { headers: 201 }, index: { ready: false, state: 'syncing',
      effective_work_ready: true, core_height: 200, core_headers: 201, verification_progress: 1,
      tip_age_seconds: 1, warnings: ['TensorCash Core is still synchronizing the chain.'] } }).gateway.network();
    expect(info).toMatchObject({ ready: true, height: 200, indexedHeight: 200, pendingValidationBlocks: 1 });
    expect(info.readinessReason).toBeUndefined();
  });
  it('still requires the index to catch up to the accepted Core tip while new headers wait', async () => {
    const info = await fixture({ core: { headers: 201 }, index: { indexed_height: 199, lag_blocks: 1, ready: false } }).gateway.network();
    expect(info).toMatchObject({ ready: false, indexedHeight: 199, readinessReason: 'index-sync' });
  });
  it.each([
    { index: { indexed_height: 201 } }, { index: { indexed_tip: 'b'.repeat(64) } },
    { index: { checked_at: now() - 31 } }, { index: { initial_block_download: true } },
    { core: { initialblockdownload: true } }, { time: now() - 7201 },
  ])('never lets pending validation bypass an index, identity, initial sync or freshness gate', async options => {
    const { gateway, calls } = fixture({ ...options, core: { headers: 205, ...options.core } });
    expect((await gateway.network()).ready).toBe(false);
    await expect(gateway.validate('00'.repeat(20))).rejects.toMatchObject({ code: 'network-not-ready' });
    expect(calls).not.toContain('testmempoolaccept');
  });
});
