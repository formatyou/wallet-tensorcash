import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Transaction } from '@scure/btc-signer';
import { hex } from '@scure/base';
import { deriveAccount, deriveAddress, createMetadata } from '../core/keys';
import { decodeNativeTransaction, prepareNativeTransfer, signNativeTransfer } from '../core/transactions';
import { acceptedTransfersKey, clearJournal, hasJournal, loadAcceptedTransfers, loadJournal, markBroadcastAttempted, rememberAcceptedTransfer, retainAcceptedTransfers, saveJournal, verifyJournal } from './broadcast-journal';

function fixture() {
  const account = deriveAccount('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', 'regtest');
  const receive = deriveAddress(account, 'regtest', 0, 0);
  const change = deriveAddress(account, 'regtest', 1, 0);
  const recipient = deriveAddress(account, 'regtest', 0, 20);
  const metadata = createMetadata(account, 'regtest', true);
  const parent = new Transaction({ version: 2, allowUnknownInputs: true });
  parent.addInput({ txid: '11'.repeat(32), index: 0, sequence: 0xffffffff });
  parent.addOutput({ amount: 1_000_000n, script: hex.decode(receive.scriptHex) });
  const rawParent = hex.encode(parent.toBytes(true, false));
  const prepared = prepareNativeTransfer({ network: 'regtest', recipient: recipient.address, amountUnits: '500000', feeRate: '2',
    change, ownedAddresses: [receive], utxos: [{ txid: decodeNativeTransaction(rawParent).txid, vout: 0, address: receive.address,
      amountUnits: '1000000', scriptHex: receive.scriptHex, confirmations: 5, blockHeight: 10, coinbase: false,
      classification: 'native', rawParent, verified: true }] }, account, metadata);
  const signed = signNativeTransfer(prepared, account);
  account.wipePrivateData();
  return { metadata, plan: prepared.plan, signed };
}
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } });
});
afterEach(() => vi.unstubAllGlobals());
describe('durable public broadcast journal', () => {
  it('preserves the identical signed retry across reload and clears only explicitly', () => {
    const f = fixture();
    expect(loadJournal(f.metadata)).toBeNull();
    saveJournal(f.metadata, f.plan, f.signed);
    expect(hasJournal(f.metadata)).toBe(true);
    expect(loadJournal(f.metadata)?.signed).toEqual(f.signed);
    expect(loadJournal(f.metadata)?.plan).toEqual(f.plan);
    expect(loadJournal(f.metadata)?.broadcastAttempted).toBe(false);
    markBroadcastAttempted(f.metadata);
    saveJournal(f.metadata, f.plan, f.signed);
    expect(loadJournal(f.metadata)?.broadcastAttempted).toBe(true);
    clearJournal(f.metadata);
    expect(loadJournal(f.metadata)).toBeNull();
  });
  it('rejects manipulated review, raw bytes, transaction identity and network', () => {
    const f = fixture(); saveJournal(f.metadata, f.plan, f.signed);
    const original = loadJournal(f.metadata)!;
    const mutations = [
      (entry: typeof original) => { entry.plan.amountUnits = '500001'; },
      (entry: typeof original) => { entry.plan.inputs[0].txid = '22'.repeat(32); },
      (entry: typeof original) => { entry.signed.rawHex += '00'; },
      (entry: typeof original) => { entry.signed.txid = '33'.repeat(32); },
      (entry: typeof original) => { entry.plan.feeUnits = '1'; },
      (entry: typeof original) => { entry.network = 'mainnet'; },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(original); mutate(changed);
      expect(() => verifyJournal(changed, f.metadata)).toThrow();
    }
    expect(() => verifyJournal(original, { ...f.metadata, id: 'different-wallet' })).toThrow();
  });
  it('fails closed if storage cannot persist the retry copy', () => {
    const f = fixture();
    vi.stubGlobal('localStorage', { setItem() {}, getItem: () => null });
    expect(() => saveJournal(f.metadata, f.plan, f.signed)).toThrow(/saved safely/);
  });
  it('keeps accepted transaction evidence independently of the blocking retry journal', () => {
    const f = fixture(); saveJournal(f.metadata, f.plan, f.signed);
    rememberAcceptedTransfer(f.metadata, f.plan, f.signed); clearJournal(f.metadata);
    expect(hasJournal(f.metadata)).toBe(false);
    expect(loadAcceptedTransfers(f.metadata)).toHaveLength(1);
    expect(loadAcceptedTransfers(f.metadata)[0].signed).toEqual(f.signed);
    rememberAcceptedTransfer(f.metadata, f.plan, f.signed);
    expect(loadAcceptedTransfers(f.metadata)).toHaveLength(1);
    retainAcceptedTransfers(f.metadata, []);
    expect(loadAcceptedTransfers(f.metadata)).toEqual([]);
  });
  it('rejects tampered, foreign-wallet and oversized accepted evidence', () => {
    const f = fixture(); const [record] = rememberAcceptedTransfer(f.metadata, f.plan, f.signed);
    for (const changed of [
      { ...record, walletId: 'foreign-wallet' },
      { ...record, network: 'mainnet' },
      { ...record, signed: { ...record.signed, txid: '33'.repeat(32) } },
      { ...record, broadcastAttempted: false },
    ]) {
      localStorage.setItem(acceptedTransfersKey(f.metadata.id), JSON.stringify([changed]));
      expect(() => loadAcceptedTransfers(f.metadata)).toThrow(/could not be verified/);
    }
    localStorage.setItem(acceptedTransfersKey(f.metadata.id), '['.repeat(2_000_001));
    expect(() => loadAcceptedTransfers(f.metadata)).toThrow(/could not be verified/);
    expect(() => retainAcceptedTransfers(f.metadata, Array(26).fill(record))).toThrow(/could not be saved safely/);
  });
});
