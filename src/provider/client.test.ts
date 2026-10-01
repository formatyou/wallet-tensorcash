import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NetworkInfo, NetworkReadinessReason } from '../shared/types';
import { assertNetworkInfo, createProvider, NetworkReadinessError } from './client';
import { networkRetryDelay } from './recovery';

const info = (): NetworkInfo => ({ network: 'regtest', chain: 'regtest',
  genesisHash: 'cf63c021e5a8ea0bc04cf7b12ab12e0a7902ef2dae5bdd8cbb3a0d41c3345da4',
  height: 105, tipHash: 'a'.repeat(64), indexedHeight: 105, ready: true, observedAt: new Date().toISOString(),
  explorerUrl: null, minConfirmations: 1, coinbaseMaturity: 100 });
afterEach(() => { vi.unstubAllGlobals(); });

describe('provider readiness responses', () => {
  it('accepts old responses without readiness details', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(info())));
    expect(await createProvider().network()).toMatchObject({ ready: true });
  });
  it('accepts a ready verified tip with informational pending-validation headers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...info(), pendingValidationBlocks: 4 })));
    expect(await createProvider().network()).toMatchObject({ ready: true, pendingValidationBlocks: 4 });
  });
  it.each([
    ['block-validation', 'Checking the latest block.'], ['node-sync', 'The network is catching up.'],
    ['index-sync', 'Updating transaction data.'], ['index-unavailable', 'Transaction data is temporarily unavailable.'],
    ['stale-data', 'Waiting for fresh network data.'],
  ] satisfies [NetworkReadinessReason, string][])('preserves validated %s details without authorizing a ready connection', async (readinessReason, message) => {
    const blocked = { ...info(), ready: false, readinessReason };
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(blocked)));
    const error = await createProvider().network().catch(failure => failure);
    expect(error).toBeInstanceOf(NetworkReadinessError);
    expect(error.info).toEqual(blocked); expect(error.message).toBe(`${message} Retrying automatically.`);
  });
  it('uses a compact fallback for legacy blocked responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...info(), ready: false })));
    await expect(createProvider().network()).rejects.toThrow('Waiting for the network. Retrying automatically.');
  });
  it('rejects unrecognized readiness details before they reach wallet state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...info(), ready: false, readinessReason: 'unknown-future-value' })));
    await expect(createProvider().network()).rejects.toThrow('incomplete or invalid wallet data');
  });
  it('retains blockchain identity checks even for blocked readiness data', () => {
    expect(() => assertNetworkInfo({ ...info(), ready: false, genesisHash: 'b'.repeat(64) })).toThrow('different blockchain');
  });
  it('rejects stale observations with a structured blocked reason even if ready is true', () => {
    try { assertNetworkInfo({ ...info(), observedAt: new Date(Date.now() - 120_001).toISOString() }); }
    catch (error) {
      expect(error).toBeInstanceOf(NetworkReadinessError);
      expect((error as NetworkReadinessError).info).toMatchObject({ ready: false, readinessReason: 'stale-data' });
      return;
    }
    throw new Error('Stale observation was allowed');
  });
  it('rejects an index behind the node even when ready is true', () => {
    expect(() => assertNetworkInfo({ ...info(), indexedHeight: 104 })).toThrow(NetworkReadinessError);
  });
  it('rejects an index ahead of the accepted node tip even when ready is true', () => {
    expect(() => assertNetworkInfo({ ...info(), indexedHeight: 106 })).toThrow(NetworkReadinessError);
  });
  it('rejects a blocked snapshot before exposing any requested wallet data', async () => {
    const address = 'bcrt1qtest';
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ network: { ...info(), ready: false, readinessReason: 'index-sync' },
      addresses: [{ address, used: false }], utxos: [], history: [], complete: false, warnings: [], observedAt: new Date().toISOString() })));
    await expect(createProvider().sync([address])).rejects.toThrow('Updating transaction data.');
  });
});

describe('light network recovery scheduling', () => {
  it('polls known readiness blocks every five seconds and keeps healthy refreshes at thirty', () => {
    expect(networkRetryDelay(false, 0)).toBe(5000); expect(networkRetryDelay(true, 0)).toBe(30000);
  });
  it('backs off transport failures to a bounded thirty seconds', () => {
    expect([1, 2, 3, 4, 50].map(attempts => networkRetryDelay(false, attempts))).toEqual([5000, 10000, 20000, 30000, 30000]);
  });
});
