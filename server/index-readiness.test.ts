import { describe, expect, it } from 'vitest';
import { indexSupportsAcceptedTip } from './index-readiness';

const tip = { height: 29212, headers: 29213, hash: '1cf4963913dfc2d777b14617b94480e4fbfe5b1f71a6306785f1ce5ea35691e3' };
const now = 1790790073;
// Captured validation-only status at 2026-09-30T17:41:13Z. The ready flag was
// false solely because one header was waiting; the accepted index was complete.
const waiting = { checked_at: now - 1, core_headers: tip.headers, core_height: tip.height,
  core_online: true, effective_work_ready: true, indexed_height: tip.height, indexed_tip: tip.hash,
  initial_block_download: false, lag_blocks: 0, ready: false, state: 'syncing', tip_age_seconds: 1622,
  verification_progress: 1, warnings: ['TensorCash Core is still synchronizing the chain.'] };
const accepted = { ...tip, headers: tip.height };
const ageOnly = { ...waiting, core_headers: accepted.headers, tip_age_seconds: 86400,
  warnings: ['The Core chain tip is older than 30 minutes.'] };

describe('accepted-tip explorer readiness', () => {
  it('uses the captured validation-only status without counting unaccepted headers as confirmations', () => {
    expect(indexSupportsAcceptedTip(waiting, tip, now)).toBe(true);
    expect(tip.height).toBe(29212);
  });
  it.each([2600, 7201, 86400, 7 * 86400])('accepts an age-only warning after a %i-second block gap', tipAge => {
    expect(indexSupportsAcceptedTip({ ...ageOnly, tip_age_seconds: tipAge }, accepted, now)).toBe(true);
  });
  it('accepts the age advisory alone when header validation is pending and all observations agree', () => {
    expect(indexSupportsAcceptedTip({ ...ageOnly, core_headers: tip.headers }, tip, now)).toBe(true);
  });
  it('accepts either ordering of both known warnings during a long block gap with pending validation', () => {
    const warnings = [...waiting.warnings, ...ageOnly.warnings];
    for (const order of [warnings, [...warnings].reverse()]) {
      expect(indexSupportsAcceptedTip({ ...waiting, tip_age_seconds: 86400, warnings: order }, tip, now)).toBe(true);
    }
  });
  it('does not impose a mining-age cutoff on explicit validation-only waiting', () => {
    expect(indexSupportsAcceptedTip({ ...waiting, tip_age_seconds: 86400 }, tip, now)).toBe(true);
  });
  it.each([
    { lag_blocks: 1 }, { indexed_height: tip.height + 1 }, { indexed_tip: 'b'.repeat(64) },
    { core_height: tip.height - 1 }, { core_headers: tip.headers - 1 },
    { core_online: false }, { initial_block_download: true }, { effective_work_ready: false },
    { verification_progress: 0.999 }, { checked_at: now - 31 }, { checked_at: now + 31 },
    { tip_age_seconds: -1 }, { tip_age_seconds: '86400' }, { state: 'unknown' }, { state: 'ready' },
    { warnings: [] }, { warnings: ['Explorer index is 1 block behind Core.'] },
    { warnings: [...waiting.warnings, 'Another provider warning.'] },
    { warnings: [...waiting.warnings, ...waiting.warnings] },
    { warnings: undefined }, { effective_work_ready: undefined }, { core_headers: undefined },
  ])('blocks ambiguous, stale or inconsistent validation evidence: %j', poisoned => {
    expect(indexSupportsAcceptedTip({ ...waiting, ...poisoned }, tip, now)).toBe(false);
  });
  it.each([
    { lag_blocks: 1 }, { indexed_height: tip.height - 1 }, { indexed_tip: 'b'.repeat(64) },
    { core_height: tip.height + 1 }, { core_headers: accepted.headers + 1 },
    { core_online: false }, { initial_block_download: true }, { effective_work_ready: false },
    { verification_progress: 0.999 }, { checked_at: now - 31 }, { checked_at: now + 31 },
    { ready: undefined }, { state: 'unknown' }, { tip_age_seconds: undefined },
    { warnings: [] }, { warnings: [...ageOnly.warnings, 'Another provider warning.'] },
    { warnings: [...ageOnly.warnings, ...waiting.warnings] }, { warnings: [...ageOnly.warnings, ...ageOnly.warnings] },
  ])('never lets a block-age advisory bypass strict observation checks: %j', poisoned => {
    expect(indexSupportsAcceptedTip({ ...ageOnly, ...poisoned }, accepted, now)).toBe(false);
  });
  it('blocks the next observed phase while the index catches up to the newly accepted block', () => {
    const next = { height: 29213, headers: 29213, hash: '775ede57ac6952d626fb14cdba1be41b5badff1eaa1a23d61783122e7a316fdb' };
    expect(indexSupportsAcceptedTip({ ...waiting, core_height: 29213, lag_blocks: 1,
      warnings: ['Explorer index is 1 block behind Core.'] }, next, now)).toBe(false);
  });
  it('does not accept a validation-only warning without a local pending header', () => {
    expect(indexSupportsAcceptedTip({ ...waiting, core_headers: accepted.headers }, accepted, now)).toBe(false);
  });
  it('retains legacy ready responses and their exact accepted-tip and observation-freshness gates', () => {
    const legacy = { ready: true, core_online: true, initial_block_download: false, lag_blocks: 0,
      indexed_height: tip.height, indexed_tip: tip.hash, checked_at: now };
    expect(indexSupportsAcceptedTip(legacy, tip, now)).toBe(true);
    expect(indexSupportsAcceptedTip({ ...legacy, indexed_height: tip.headers }, tip, now)).toBe(false);
    expect(indexSupportsAcceptedTip({ ...legacy, checked_at: now - 31 }, tip, now)).toBe(false);
    expect(indexSupportsAcceptedTip(legacy, { ...tip, headers: tip.height - 1 }, now)).toBe(false);
  });
});
