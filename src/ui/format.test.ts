import { describe, expect, it } from 'vitest';
import { confirmationView, formatDuration, formatTsc, formatUpdatedAt, parseTsc, safeExplorerLink, walletBalances } from './format';
import type { Utxo, WalletSnapshot } from '../shared/types';

function coin(overrides: Partial<Utxo> = {}): Utxo {
  return { txid: 'a'.repeat(64), vout: 0, address: 'test-address', scriptHex: '0014' + 'b'.repeat(40),
    amountUnits: '100000000', confirmations: 1, blockHeight: 100, coinbase: false,
    classification: 'native', rawParent: '0200000001', verified: true, ...overrides };
}
function balanceSnapshot(utxos: Utxo[]): WalletSnapshot {
  return { network: { network: 'mainnet', chain: 'tensor', genesisHash: 'a'.repeat(64),
    height: 102, tipHash: 'b'.repeat(64), indexedHeight: 102, ready: true, observedAt: new Date().toISOString(),
    explorerUrl: null, minConfirmations: 3, coinbaseMaturity: 100 },
    addresses: [], utxos, history: [], complete: true, warnings: [], observedAt: new Date().toISOString() };
}

describe('TSC display and user amounts', () => {
  it('preserves atomic precision without floating point', () => {
    expect(parseTsc('9007199254740993.00000001')).toBe('900719925474099300000001');
    expect(formatTsc('900719925474099300000001')).toBe('9007199254740993.00000001');
    expect(formatTsc('-1')).toBe('−0.00000001');
  });
  it('rejects ambiguous, nonpositive and overprecise user amounts', () => {
    for (const invalid of ['0', '-1', '1e3', '1,000', '0.000000001', 'Infinity', '.1']) {
      expect(() => parseTsc(invalid)).toThrow();
    }
  });
});
describe('external history links', () => {
  const txid = 'a'.repeat(64);
  it('permits a secure explorer and local regtest explorer', () => {
    expect(safeExplorerLink('https://tscscan.xyz', txid)).toBe(`https://tscscan.xyz/tx/${txid}`);
    expect(safeExplorerLink('http://127.0.0.1:3000/', txid)).toBe(`http://127.0.0.1:3000/tx/${txid}`);
  });
  it('rejects active schemes and invalid transaction identifiers', () => {
    expect(safeExplorerLink('javascript:alert(1)', txid)).toBeNull();
    expect(safeExplorerLink('https://tscscan.xyz', '../bad')).toBeNull();
  });
});
describe('confirmation-aware wallet balances', () => {
  it('keeps verified funds pending at zero, one and two confirmations, then spendable at three', () => {
    for (const confirmations of [0, 1, 2]) {
      expect(walletBalances(balanceSnapshot([coin({ confirmations })]))).toEqual({
        spendable: 0n, pending: 100_000_000n, unsupported: 0n,
      });
    }
    expect(walletBalances(balanceSnapshot([coin({ confirmations: 3 })]))).toEqual({
      spendable: 100_000_000n, pending: 0n, unsupported: 0n,
    });
  });
  it('keeps coinbase pending until maturity even after the ordinary confirmation threshold', () => {
    expect(walletBalances(balanceSnapshot([coin({ coinbase: true, confirmations: 99 })]))).toEqual({
      spendable: 0n, pending: 100_000_000n, unsupported: 0n,
    });
    expect(walletBalances(balanceSnapshot([coin({ coinbase: true, confirmations: 100 })]))).toEqual({
      spendable: 100_000_000n, pending: 0n, unsupported: 0n,
    });
  });
  it('counts unsupported, unknown, unverified and missing-raw funds separately without pending overlap', () => {
    const snapshot = balanceSnapshot([
      coin({ classification: 'unsupported', confirmations: 0 }),
      coin({ classification: 'unknown', confirmations: 0 }),
      coin({ verified: false, confirmations: 0 }),
      coin({ rawParent: null, confirmations: 0 }),
      coin({ confirmations: 1 }),
      coin({ confirmations: 3 }),
    ]);
    expect(walletBalances(snapshot)).toEqual({ spendable: 100_000_000n, pending: 100_000_000n, unsupported: 400_000_000n });
  });
});

describe('confirmation progress and approximate wait', () => {
  it('shows the date for a last-known balance from an earlier day or year', () => {
    const now = new Date(2026, 8, 30, 15, 0);
    expect(formatUpdatedAt(new Date(2026, 8, 30, 14, 0).toISOString(), now)).not.toContain(' · ');
    expect(formatUpdatedAt(new Date(2026, 8, 29, 14, 0).toISOString(), now)).toContain(' · ');
    expect(formatUpdatedAt(new Date(2025, 8, 30, 14, 0).toISOString(), now)).toContain('2025');
  });
  it.each([1, 2, 3])('uses the configured threshold of %i confirmations and caps completed progress', required => {
    const network = { ...balanceSnapshot([]).network, minConfirmations: required, averageBlockSeconds: 60 };
    for (const confirmations of [0, 1, 2, 3, 7]) {
      const view = confirmationView({ txid: 'a'.repeat(64), deltaUnits: '1', feeUnits: null,
        status: confirmations ? 'confirmed' : 'pending', confirmations,
        blockHeight: confirmations ? 100 : null, timestamp: null }, network);
      expect(view.confirmed).toBe(confirmations >= required);
      expect(view.progress).toBe(`${Math.min(confirmations, required)}/${required}`);
      expect(view.estimate).toBe(confirmations < required ? `approx. ${required - confirmations} min` : null);
      expect(view.label).toBe(confirmations < required ? 'Pending' : 'Confirmed');
    }
  });
  it('does not invent a deadline when timing is unavailable, the transfer conflicted, or blocks are manually mined', () => {
    const entry = { txid: 'a'.repeat(64), deltaUnits: '1', feeUnits: null, status: 'pending' as const,
      confirmations: 0, blockHeight: null, timestamp: null };
    const network = balanceSnapshot([]).network;
    expect(confirmationView(entry, network).estimate).toBeNull();
    expect(confirmationView({ ...entry, status: 'conflicted' }, { ...network, averageBlockSeconds: 60 }).estimate).toBeNull();
    expect(confirmationView(entry, { ...network, network: 'regtest', averageBlockSeconds: 60 }).estimate).toBeNull();
    expect(formatDuration(30.4)).toBe('31 sec');
    expect(formatDuration(61)).toBe('2 min');
    expect(formatDuration(5400)).toBe('1 hr 30 min');
  });
});
