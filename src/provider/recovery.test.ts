import { describe, expect, it } from 'vitest';
import { WalletRecovery } from './recovery';

describe('verified wallet recovery', () => {
  it('does not consume recovery when network readiness succeeds before the wallet can refresh', () => {
    const recovery = new WalletRecovery();
    recovery.require();
    expect(recovery.due(0)).toBe(true);
    // Readiness may return while a wallet operation is busy. The pending work
    // remains due on the next tick, including after subsequent healthy probes.
    expect(recovery.delay(true, 0, 1000)).toBe(1000);
    expect(recovery.due(2000)).toBe(true);
    recovery.succeeded();
    expect(recovery.needed).toBe(false); expect(recovery.delay(true, 0, 3000)).toBe(30_000);
  });
  it('retries failed wallet reads promptly even while the network stays ready', () => {
    const recovery = new WalletRecovery();
    recovery.failed(1000);
    expect(recovery.delay(true, 0, 1000)).toBe(5000);
    expect(recovery.due(5999)).toBe(false); expect(recovery.due(6000)).toBe(true);
    recovery.failed(6000);
    expect(recovery.delay(true, 0, 6000)).toBe(10_000);
    recovery.failed(16_000);
    expect(recovery.delay(true, 0, 16_000)).toBe(20_000);
    recovery.failed(36_000);
    expect(recovery.delay(true, 0, 36_000)).toBe(30_000);
  });
  it('keeps lightweight readiness polling separate from failed full wallet reads', () => {
    const recovery = new WalletRecovery();
    for (let attempt = 0; attempt < 6; attempt++) recovery.failed(0);
    expect(recovery.delay(false, 0, 0)).toBe(5000);
    expect(recovery.delay(false, 3, 0)).toBe(20_000);
  });
  it('resets failure backoff only after a successful wallet refresh', () => {
    const recovery = new WalletRecovery();
    recovery.failed(0); recovery.failed(5000); recovery.succeeded();
    recovery.failed(20_000);
    expect(recovery.delay(true, 0, 20_000)).toBe(5000);
  });
});
