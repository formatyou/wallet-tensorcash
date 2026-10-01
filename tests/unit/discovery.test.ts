import { describe, expect, it } from 'vitest';
import { discoverWallet, refreshKnownWallet } from '../../src/provider/discovery';
import type { ChainProvider } from '../../src/provider/client';
import type { AddressRecord, NetworkInfo, WalletEngine, WalletSnapshot } from '../../src/shared/types';

const genesis = 'cf63c021e5a8ea0bc04cf7b12ab12e0a7902ef2dae5bdd8cbb3a0d41c3345da4';
function fixture(used: Set<string> = new Set(), mutate?: (snapshot: WalletSnapshot, call: number) => void) {
  let calls = 0;
  const network: NetworkInfo = { network: 'regtest', chain: 'regtest', genesisHash: genesis, height: 103, tipHash: 'a'.repeat(64), indexedHeight: 103, ready: true, observedAt: new Date().toISOString(), explorerUrl: null, minConfirmations: 1, coinbaseMaturity: 100 };
  const engine = {
    async getMetadata() { return { network: 'regtest' }; },
    async getAddresses(branch: 0 | 1, start: number, count: number): Promise<AddressRecord[]> {
      return Array.from({ length: count }, (_, offset) => ({ address: `${branch}:${start + offset}`, scriptHex: '0014' + 'a'.repeat(40), branch, index: start + offset, path: `m/84'/1'/0'/${branch}/${start + offset}` }));
    },
  } as WalletEngine;
  const provider = {
    async network() { return network; },
    async sync(addresses: string[]): Promise<WalletSnapshot> {
      const snapshot: WalletSnapshot = { network, addresses: addresses.map(address => ({ address, used: used.has(address) })), utxos: [], history: [], complete: true, warnings: [], observedAt: new Date().toISOString(), mempoolFingerprint: 'b'.repeat(64) };
      mutate?.(snapshot, ++calls); return snapshot;
    },
  } as ChainProvider;
  return { engine, provider };
}
describe('HD discovery and recovery', () => {
  it('finds both external and internal activity beyond the first address window', async () => {
    const { engine, provider } = fixture(new Set(['0:19', '0:25', '1:19', '1:23']));
    const result = await discoverWallet(engine, provider);
    expect(result.receive.index).toBe(26); expect(result.change.index).toBe(24);
    expect(result.ownedAddresses.some(a => a.branch === 1 && a.index === 23)).toBe(true);
  });
  it('preserves the publicly reserved receive cursor after reload', async () => {
    const { engine, provider } = fixture();
    const result = await discoverWallet(engine, provider, undefined, 39);
    expect(result.receive.index).toBe(39); expect(result.change.index).toBe(0);
  });
  it('reuses the terminal issued address and preserves a full recovery gap', async () => {
    const used = new Set(Array.from({ length: 9 }, (_, i) => [`0:${i * 20 + 19}`, `1:${i * 20 + 19}`]).flat());
    const { engine, provider } = fixture(used);
    const result = await discoverWallet(engine, provider, undefined, 179);
    expect(result.receive.index).toBe(179); expect(result.change.index).toBe(179);
    expect(result.snapshot.warnings.join(' ')).toContain('reused');
    await expect(discoverWallet(engine, provider, undefined, 180)).rejects.toThrow('recovery range');
  });
  it('rejects a changing mempool even when the block tip is unchanged', async () => {
    const { engine, provider } = fixture(new Set(['0:24', '1:24', '0:49', '1:49']), (snapshot, call) => { if (call % 2 === 0) snapshot.mempoolFingerprint = 'c'.repeat(64); });
    await expect(discoverWallet(engine, provider)).rejects.toThrow('pending transfers changed');
  });
  it('retries a transient mempool race and returns only a consistent attempt', async () => {
    const { engine, provider } = fixture(new Set(['0:24', '1:24', '0:49', '1:49']), (snapshot, call) => { if (call === 2) snapshot.mempoolFingerprint = 'c'.repeat(64); });
    const result = await discoverWallet(engine, provider);
    expect(result.snapshot.complete).toBe(true);
    expect(result.snapshot.mempoolFingerprint).toBe('b'.repeat(64));
  });
  it('does not turn a truncated address history into an empty wallet', async () => {
    const { engine, provider } = fixture(new Set(), snapshot => { snapshot.complete = false; snapshot.warnings = ['History pagination limit reached.']; });
    await expect(discoverWallet(engine, provider)).rejects.toThrow('pagination');
  });
  it('stops at the recovery bound rather than silently omitting later funds', async () => {
    const used = new Set(Array.from({ length: 200 }, (_, i) => `0:${i}`));
    const { engine, provider } = fixture(used);
    await expect(discoverWallet(engine, provider)).rejects.toThrow('scan limit');
  });
  it('aggregates a self-transfer across external and change address batches', async () => {
    const { engine, provider } = fixture(new Set(['0:24', '1:24', '0:49', '1:49']), (snapshot, call) => { snapshot.history = [{ txid: 'd'.repeat(64), deltaUnits: call === 1 ? '-100000' : '99700', feeUnits: '300', status: 'confirmed', confirmations: 3, blockHeight: 101, timestamp: 1 }]; });
    const result = await discoverWallet(engine, provider);
    expect(result.snapshot.history).toHaveLength(1); expect(result.snapshot.history[0].deltaUnits).toBe('-300');
  });
  it('batches both branches into one initial and one light refresh request', async () => {
    const { engine, provider } = fixture(); const lengths: number[] = [];
    const sync = provider.sync;
    provider.sync = addresses => { lengths.push(addresses.length); return sync(addresses); };
    const known = await discoverWallet(engine, provider);
    const refreshed = await refreshKnownWallet(engine, provider, known);
    expect(lengths).toEqual([50, 50]); expect(refreshed.ownedAddresses).toEqual(known.ownedAddresses);
  });
  it('widens known discovery when activity consumes the trailing recovery gap', async () => {
    const used = new Set<string>(); const { engine, provider } = fixture(used);
    const known = await discoverWallet(engine, provider);
    used.add('0:24'); used.add('1:24');
    const refreshed = await refreshKnownWallet(engine, provider, known);
    expect(refreshed.receive.index).toBe(25); expect(refreshed.change.index).toBe(25);
    expect(refreshed.ownedAddresses).toHaveLength(150);
  });
  it('preserves the prior complete result when a light refresh is incomplete', async () => {
    let incomplete = false;
    const { engine, provider } = fixture(new Set(), snapshot => { if (incomplete) { snapshot.complete = false; snapshot.warnings = ['History unavailable']; } });
    const known = await discoverWallet(engine, provider); const before = structuredClone(known); incomplete = true;
    await expect(refreshKnownWallet(engine, provider, known)).rejects.toThrow('History unavailable');
    expect(known).toEqual(before); expect(known.snapshot.complete).toBe(true);
  });
  it('rejects missing addresses, missing mempool checkpoint and UTXO/history mismatch', async () => {
    for (const poison of [
      (snapshot: WalletSnapshot) => { snapshot.addresses.pop(); },
      (snapshot: WalletSnapshot) => { delete snapshot.mempoolFingerprint; },
      (snapshot: WalletSnapshot) => { snapshot.addresses[0].used = true; snapshot.utxos.push({ txid: 'd'.repeat(64), vout: 0, address: snapshot.addresses[0].address, scriptHex: '0014' + 'a'.repeat(40), amountUnits: '1000', confirmations: 0, blockHeight: null, coinbase: false, classification: 'native', rawParent: null, verified: false }); },
    ]) {
      const { engine, provider } = fixture(new Set(), poison);
      await expect(discoverWallet(engine, provider)).rejects.toThrow();
    }
  });
  it('rejects a chain tip changed after the last address batch', async () => {
    const { engine, provider } = fixture(); const initial = await provider.network();
    let reads = 0; provider.network = async () => ({ ...initial, tipHash: ++reads === 1 ? initial.tipHash : 'e'.repeat(64) });
    await expect(discoverWallet(engine, provider)).rejects.toThrow('chain tip changed');
  });
});
