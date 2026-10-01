import { describe, expect, it } from 'vitest';
import { quoteNativeSendMax } from '../../src/core/fees';

describe('send-max fee quote bounds', () => {
  it('does not quote unknown, zero, oversized or noncanonical input amounts', () => {
    expect(() => quoteNativeSendMax([], '2')).toThrow(/No spendable/);
    for (const amountUnits of ['0', '01', '-1', '0.1', '2100000000000001']) {
      expect(() => quoteNativeSendMax([{ amountUnits }], '2')).toThrow();
    }
    expect(() => quoteNativeSendMax([{ amountUnits: '2100000000000000' }, { amountUnits: '1' }], '2')).toThrow(/inventory/);
  });
  it('refuses an unusable amount, excessive fees and more inputs than the signer supports', () => {
    expect(() => quoteNativeSendMax([{ amountUnits: '200' }], '2')).toThrow(/too small/);
    expect(() => quoteNativeSendMax([{ amountUnits: '1000' }], '1')).toThrow(/5%/);
    expect(() => quoteNativeSendMax(Array.from({ length: 100 }, () => ({ amountUnits: '100000000' })), '1000')).toThrow(/Fee exceeds/);
    expect(() => quoteNativeSendMax(Array.from({ length: 101 }, () => ({ amountUnits: '100000000' })), '2')).toThrow(/input-count/);
  });
});
