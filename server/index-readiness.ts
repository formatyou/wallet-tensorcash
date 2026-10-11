import type { NetworkReadinessReason } from '../src/shared/types';
import { hash, integer, record, type RecordData } from './data';
import { ensure } from './errors';

export interface AcceptedTip { height: number; hash: string; headers: number; }
export interface IndexTip { height: number; hash: string; }
export interface IndexReadiness { ready: boolean; indexedHeight: number; reason?: NetworkReadinessReason; }
const COVERAGE = ['blocks', 'transactions', 'addresses'];
const MAX_POLL_AGE_SECONDS = 30;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

// `status` is the `data` of the index's /v1/status; `index` is the chain tip from that
// response's X-Chain-Height/X-Chain-Hash headers. Balances and spends need a complete
// index exactly at Core's accepted tip, observed by the index within 30 seconds. Block
// age is not a gate: a mining pause leaves a freshly observed accepted tip usable.
export function indexReadiness(status: RecordData, index: IndexTip, tip: AcceptedTip, now: number): IndexReadiness {
  let indexedHeight = 0;
  try {
    ensure(status.network === 'mainnet', 'Index serves a different network');
    const coverage = record(status.coverage);
    // A partial scope (e.g. a reindex from a later height) would silently omit older history.
    const through = COVERAGE.map(name => { const item = record(coverage[name]); return { complete: item.state === 'complete' && item.scope === 'chain_wide', height: integer(item.through_height) }; });
    indexedHeight = Math.min(...through.map(item => item.height));
    ensure(typeof status.last_core_poll_at === 'string' && ISO_UTC.test(status.last_core_poll_at));
    const polled = Date.parse(status.last_core_poll_at) / 1000; ensure(Number.isFinite(polled));
    if (Math.abs(now - polled) > MAX_POLL_AGE_SECONDS) return { ready: false, indexedHeight, reason: 'stale-data' };
    if (status.core_initial_block_download !== false) return { ready: false, indexedHeight, reason: 'node-sync' };
    if (index.height !== tip.height || hash(index.hash) !== tip.hash || integer(status.observed_core_height) !== tip.height
      || through.some(item => !item.complete || item.height !== tip.height)) return { ready: false, indexedHeight, reason: 'index-sync' };
    // Complete at the accepted tip but not declared ready: while Core itself still
    // validates newer headers this is the expected short wait, otherwise index sync.
    if (status.sync_state !== 'ready') return { ready: false, indexedHeight, reason: tip.headers > tip.height ? 'block-validation' : 'index-sync' };
    return { ready: true, indexedHeight };
  } catch { return { ready: false, indexedHeight, reason: 'index-unavailable' }; }
}
