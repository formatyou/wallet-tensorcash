import { describe, expect, it } from 'vitest';
import { indexReadiness } from './index-readiness';

const tip = { height: 30837, headers: 30837, hash: '1b3f84124bb54b9b64d370a5275a50dd9339151a4e2fa8285e7fe9c6cedfbc77' };
const now = Date.parse('2026-10-11T08:36:00Z') / 1000;
const covered = (height: number) => ({ scope: 'chain_wide', state: 'complete', through_height: height });
// Captured from https://api.tscscan.xyz/v1/status at 2026-10-11T08:36Z; the chain tip
// comes from that response's X-Chain-Height/X-Chain-Hash headers.
const status = { core_initial_block_download: false, last_core_poll_at: '2026-10-11T08:35:54Z', network: 'mainnet',
  observed_core_height: 30837, observed_header_height: 30837, sync_state: 'ready',
  coverage: { addresses: covered(30837), assets: covered(30837), blocks: covered(30837), models: covered(30837), proof: covered(30837), transactions: covered(30837) } };
const index = { height: tip.height, hash: tip.hash };

describe('accepted-tip index readiness', () => {
  it('accepts the captured ready status exactly at the accepted Core tip', () => {
    expect(indexReadiness(status, index, tip, now)).toEqual({ ready: true, indexedHeight: 30837 });
  });
  it('accepts a fresh poll time with milliseconds', () => {
    expect(indexReadiness({ ...status, last_core_poll_at: new Date((now - 1) * 1000).toISOString() }, index, tip, now).ready).toBe(true);
  });
  it('ignores coverage of features the wallet does not read', () => {
    expect(indexReadiness({ ...status, coverage: { ...status.coverage, assets: { state: 'indexing', through_height: 1 } } }, index, tip, now).ready).toBe(true);
  });
  it.each([
    ['a stale poll', { last_core_poll_at: '2026-10-11T08:35:29Z' }, 'stale-data'],
    ['a future poll', { last_core_poll_at: '2026-10-11T08:36:31Z' }, 'stale-data'],
    ['an index node in initial sync', { core_initial_block_download: true }, 'node-sync'],
    ['a missing initial-sync flag', { core_initial_block_download: undefined }, 'node-sync'],
    ['an index node behind the accepted tip', { observed_core_height: 30836 }, 'index-sync'],
    ['incomplete address coverage', { coverage: { ...status.coverage, addresses: covered(30836) } }, 'index-sync'],
    ['a partial address scope', { coverage: { ...status.coverage, addresses: { ...covered(30837), scope: 'from_height' } } }, 'index-sync'],
    ['a missing coverage scope', { coverage: { ...status.coverage, blocks: { state: 'complete', through_height: 30837 } } }, 'index-sync'],
    ['indexing transactions', { coverage: { ...status.coverage, transactions: { ...covered(30837), state: 'indexing' } } }, 'index-sync'],
    ['coverage ahead of the accepted tip', { coverage: { ...status.coverage, blocks: covered(30838) } }, 'index-sync'],
    ['an unknown sync state', { sync_state: 'degraded' }, 'index-sync'],
    ['another network', { network: 'testnet' }, 'index-unavailable'],
    ['missing coverage', { coverage: { blocks: covered(30837) } }, 'index-unavailable'],
    ['a non-UTC poll time', { last_core_poll_at: '2026-10-11T10:35:54+02:00' }, 'index-unavailable'],
    ['a numeric poll time', { last_core_poll_at: now }, 'index-unavailable'],
    ['a fractional height', { observed_core_height: 30837.5 }, 'index-unavailable'],
  ] as const)('blocks %s', (_name, change, reason) => {
    expect(indexReadiness({ ...status, ...change }, index, tip, now)).toMatchObject({ ready: false, reason });
  });
  it.each([
    ['behind', { height: 30836, hash: 'b'.repeat(64) }], ['ahead', { height: 30838, hash: 'b'.repeat(64) }], ['on a fork', { height: 30837, hash: 'b'.repeat(64) }],
  ])('blocks an index tip %s of the accepted Core tip', (_name, other) => {
    expect(indexReadiness(status, other, tip, now)).toMatchObject({ ready: false, reason: 'index-sync' });
  });
  it('reports pending header validation only for a complete exact index that is not declared ready', () => {
    const waiting = { ...tip, headers: tip.height + 1 };
    expect(indexReadiness({ ...status, sync_state: 'syncing' }, index, waiting, now)).toMatchObject({ ready: false, reason: 'block-validation' });
    expect(indexReadiness({ ...status, sync_state: 'syncing' }, index, tip, now)).toMatchObject({ ready: false, reason: 'index-sync' });
    expect(indexReadiness(status, index, waiting, now)).toEqual({ ready: true, indexedHeight: 30837 });
    expect(indexReadiness({ ...status, sync_state: 'syncing', observed_core_height: 30836 }, index, waiting, now)).toMatchObject({ reason: 'index-sync' });
  });
});
