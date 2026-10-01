import { describe, expect, it } from 'vitest';
import { indexSupportsAcceptedTip } from './index-readiness';

const tip = { height: 29212, headers: 29213, hash: '1cf4963913dfc2d777b14617b94480e4fbfe5b1f71a6306785f1ce5ea35691e3' };
const now = 1790790073;
// Captured validation-only status at2026-09-30T17:41:13Z. The ready flag was
// false solely because one header was waiting; the accepted index was complete.
const waiting = { checked_at: now - 1, core_headers: tip.headers, core_height: tip.height,
  core_online: true, effective_work_ready: true, indexed_height: tip.height, indexed_tip: tip.hash,
  initial_block_download: false, lag_blocks: 0, ready: false, state: 'syncing', tip_age_seconds: 1622,
  verification_progress: 1, warnings: ['TensorCash Core is still synchronizing the chain.'] };

describe('accepted-tip explorer readiness', () => {
  it('uses the captured validation-only status without counting unaccepted headers as confirmations', () => {
    expect(indexSupportsAcceptedTip(waiting, tip, now, 7200)).toBe(true);
    expect(tip.height).toBe(29212);
  });
  it.each([
    { lag_blocks: 1 }, { indexed_height: tip.height + 1 }, { indexed_tip: 'b'.repeat(64) },
    { core_height: tip.height - 1 }, { core_headers: tip.headers - 1 },
    { core_online: false }, { initial_block_download: true }, { effective_work_ready: false },
    { verification_progress: 0.999 }, { checked_at: now - 31 }, { checked_at: now + 31 },
    { tip_age_seconds: 7201 }, { state: 'unknown' }, { state: 'ready' },
    { warnings: [] }, { warnings: ['Explorer index is 1 block behind Core.'] },
    { warnings: [...waiting.warnings, 'Another provider warning.'] },
    { warnings: undefined }, { effective_work_ready: undefined }, { core_headers: undefined },
  ])('blocks ambiguous, stale or inconsistent evidence: %j', poisoned => {
    expect(indexSupportsAcceptedTip({ ...waiting, ...poisoned }, tip, now, 7200)).toBe(false);
  });
  it('blocks the next observed phase while the index catches up to the newly accepted block', () => {
    const accepted = { height: 29213, headers: 29213, hash: '775ede57ac6952d626fb14cdba1be41b5badff1eaa1a23d61783122e7a316fdb' };
    expect(indexSupportsAcceptedTip({ ...waiting, core_height: 29213, lag_blocks: 1,
      warnings: ['Explorer index is 1 block behind Core.'] }, accepted, now, 7200)).toBe(false);
  });
  it('never overrides a not-ready explorer when there is no local pending header', () => {
    expect(indexSupportsAcceptedTip(waiting, { ...tip, headers: tip.height }, now, 7200)).toBe(false);
  });
  it('retains legacy ready responses and their exact accepted-tip and freshness gates', () => {
    const legacy = { ready: true, core_online: true, initial_block_download: false, lag_blocks: 0,
      indexed_height: tip.height, indexed_tip: tip.hash, checked_at: now };
    expect(indexSupportsAcceptedTip(legacy, tip, now, 7200)).toBe(true);
    expect(indexSupportsAcceptedTip({ ...legacy, indexed_height: tip.headers }, tip, now, 7200)).toBe(false);
  });
});
