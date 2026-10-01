import { describe, expect, it } from 'vitest';
import { Transaction } from '@scure/btc-signer';
import { hex } from '@scure/base';
import { createMetadata, deriveAccount, deriveAddress } from '../../src/core/keys';
import { NETWORKS } from '../../src/core/network';
import { decodeNativeTransaction, prepareNativeTransfer, signNativeTransfer } from '../../src/core/transactions';
import { isPendingTransferReconciled, reconcilePendingTransfers } from '../../src/wallet/reconciliation';
import { eligibleUtxos, walletBalances } from '../../src/ui/format';
import type { WalletSnapshot } from '../../src/shared/types';

function fixture(self = false, sendMax = false) {
  const account = deriveAccount('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', 'mainnet');
  const other = deriveAccount('legal winner thank year wave sausage worth useful legal winner thank yellow', 'mainnet');
  try {
    const receive = deriveAddress(account, 'mainnet', 0, 0); const change = deriveAddress(account, 'mainnet', 1, 0);
    const recipient = self ? receive : deriveAddress(other, 'mainnet', 0, 0);
    const parent = new Transaction({ version: 2, allowUnknownInputs: true });
    parent.addInput({ txid: '11'.repeat(32), index: 0, sequence: 0xffffffff });
    parent.addOutput({ amount: 5_000_000n, script: hex.decode(receive.scriptHex) });
    const rawParent = hex.encode(parent.toBytes(true, false)); const txid = decodeNativeTransaction(rawParent).txid;
    const coin = { txid, vout: 0, address: receive.address, scriptHex: receive.scriptHex, amountUnits: '5000000',
      confirmations: 3, blockHeight: 498, coinbase: false, classification: 'native' as const, rawParent, verified: true };
    const prepared = prepareNativeTransfer({ network: 'mainnet', recipient: recipient.address, amountUnits: sendMax ? '0' : '1000000',
      sendMax, feeRate: '2', utxos: [coin], ownedAddresses: [receive], change }, account, createMetadata(account, 'mainnet', true));
    const signed = signNativeTransfer(prepared, account);
    const snapshot: WalletSnapshot = {
      network: { network: 'mainnet', chain: 'tensor', genesisHash: NETWORKS.mainnet.genesisHash, height: 500, indexedHeight: 500,
        tipHash: 'a'.repeat(64), ready: true, observedAt: new Date().toISOString(), explorerUrl: null, minConfirmations: 3, coinbaseMaturity: 100 },
      addresses: [{ address: receive.address, used: true }, { address: change.address, used: false }],
      utxos: [coin], history: [{ txid, deltaUnits: '5000000', feeUnits: null, status: 'confirmed', confirmations: 3, blockHeight: 498, timestamp: 1 }],
      complete: true, warnings: [], observedAt: new Date().toISOString(), mempoolFingerprint: 'b'.repeat(64),
    };
    return { snapshot, pending: { plan: prepared.plan, signed }, owned: [receive, change], change, receive };
  } finally { account.wipePrivateData(); other.wipePrivateData(); }
}

describe('accepted-transfer balance reconciliation', () => {
  it('immediately locks the spent 0.05 input and shows change from a 0.01 payment as pending', () => {
    const f = fixture(); const original = structuredClone(f.snapshot);
    const reconciled = reconcilePendingTransfers(f.snapshot, [f.pending], f.owned);
    expect(f.snapshot).toEqual(original);
    expect(reconciled.complete).toBe(true); expect(reconciled.network.ready).toBe(true);
    expect(reconciled.utxos).toHaveLength(1);
    expect(reconciled.utxos[0]).toMatchObject({ txid: f.pending.signed.txid, vout: 1, confirmations: 0, blockHeight: null,
      amountUnits: f.pending.plan.changeUnits, address: f.change.address });
    expect(eligibleUtxos(reconciled)).toEqual([]);
    expect(walletBalances(reconciled)).toEqual({ spendable: 0n, pending: BigInt(f.pending.plan.changeUnits), unsupported: 0n });
    expect(reconciled.history.find(item => item.txid === f.pending.signed.txid)).toMatchObject({
      deltaUnits: String(-1_000_000n - BigInt(f.pending.plan.feeUnits)), feeUnits: f.pending.plan.feeUnits, status: 'pending', confirmations: 0,
    });
  });
  it('fills omitted change and fixes a partial input-only history without counting the original input', () => {
    const f = fixture(); f.snapshot.utxos = [];
    f.snapshot.history.push({ txid: f.pending.signed.txid, deltaUnits: '-5000000', feeUnits: f.pending.plan.feeUnits,
      status: 'pending', confirmations: 0, blockHeight: null, timestamp: 2 });
    expect(isPendingTransferReconciled(f.snapshot, f.pending, f.owned)).toBe(false);
    const reconciled = reconcilePendingTransfers(f.snapshot, [f.pending], f.owned);
    expect(walletBalances(reconciled).pending).toBe(BigInt(f.pending.plan.changeUnits));
    expect(reconciled.history.find(item => item.txid === f.pending.signed.txid)?.deltaUnits)
      .toBe(String(-1_000_000n - BigInt(f.pending.plan.feeUnits)));
  });
  it('accepts only a fully matching authoritative result and preserves its real confirmations', () => {
    const f = fixture(); const authoritative = reconcilePendingTransfers(f.snapshot, [f.pending], f.owned);
    authoritative.utxos[0].confirmations = 3; authoritative.utxos[0].blockHeight = 498;
    const history = authoritative.history.find(item => item.txid === f.pending.signed.txid)!;
    history.status = 'confirmed'; history.confirmations = 3; history.blockHeight = 498;
    expect(isPendingTransferReconciled(authoritative, f.pending, f.owned)).toBe(true);
    expect(reconcilePendingTransfers(authoritative, [f.pending], f.owned).utxos).toEqual(authoritative.utxos);
    expect(walletBalances(authoritative).spendable).toBe(BigInt(f.pending.plan.changeUnits));
    authoritative.complete = false;
    expect(isPendingTransferReconciled(authoritative, f.pending, f.owned)).toBe(false);
  });
  it('is idempotent and counts a transfer to self as only the fee leaving the wallet', () => {
    const f = fixture(true); const once = reconcilePendingTransfers(f.snapshot, [f.pending, f.pending], f.owned);
    const twice = reconcilePendingTransfers(once, [f.pending], f.owned);
    expect(twice.utxos).toEqual(once.utxos); expect(twice.history).toEqual(once.history);
    expect(once.history.find(item => item.txid === f.pending.signed.txid)?.deltaUnits).toBe(`-${f.pending.plan.feeUnits}`);
    expect(walletBalances(once).pending).toBe(5_000_000n - BigInt(f.pending.plan.feeUnits));
  });
  it('does not resurrect change proven spent by a later active transaction', () => {
    const f = fixture(); const snapshot = reconcilePendingTransfers(f.snapshot, [f.pending], f.owned);
    snapshot.utxos = [];
    snapshot.history.push({ txid: 'd'.repeat(64), deltaUnits: `-${f.pending.plan.changeUnits}`, feeUnits: '200',
      status: 'confirmed', confirmations: 3, blockHeight: 498, timestamp: 3 });
    snapshot.spentOutpoints = [{ txid: f.pending.signed.txid, vout: 1, spentByTxid: 'd'.repeat(64) }];
    expect(isPendingTransferReconciled(snapshot, f.pending, f.owned)).toBe(true);
    expect(reconcilePendingTransfers(snapshot, [f.pending], f.owned).utxos).toEqual([]);
    snapshot.history.at(-1)!.status = 'conflicted';
    expect(isPendingTransferReconciled(snapshot, f.pending, f.owned)).toBe(false);
  });
  it('adds send-max history without manufacturing a change output', () => {
    const f = fixture(false, true); const reconciled = reconcilePendingTransfers(f.snapshot, [f.pending], f.owned);
    expect(reconciled.utxos).toEqual([]); expect(walletBalances(reconciled).pending).toBe(0n);
    expect(reconciled.history.find(item => item.txid === f.pending.signed.txid)?.deltaUnits).toBe('-5000000');
    expect(isPendingTransferReconciled(reconciled, f.pending, f.owned)).toBe(true);
  });
  it.each(['pending', 'confirmed'] as const)('does not manufacture original change after a %s competing spend', status => {
    const f = fixture(); f.snapshot.utxos = [];
    const competing = 'd'.repeat(64);
    f.snapshot.history.push({ txid: competing, deltaUnits: '-5000000', feeUnits: '200', status,
      confirmations: status === 'confirmed' ? 1 : 0, blockHeight: status === 'confirmed' ? 500 : null, timestamp: 2 });
    f.snapshot.spentOutpoints = [{ txid: f.pending.plan.inputs[0].txid, vout: f.pending.plan.inputs[0].vout, spentByTxid: competing }];
    const projected = reconcilePendingTransfers(f.snapshot, [f.pending], f.owned);
    expect(projected.utxos).toEqual([]);
    expect(walletBalances(projected).pending).toBe(0n);
    expect(projected.history.find(item => item.txid === f.pending.signed.txid)?.status).toBe('conflicted');
    expect(isPendingTransferReconciled(f.snapshot, f.pending, f.owned)).toBe(status === 'confirmed');
  });
  it('does not retire a receipt from an incomplete, missing or conflicted competing-spend claim', () => {
    const f = fixture(); f.snapshot.utxos = [];
    f.snapshot.spentOutpoints = [{ txid: f.pending.plan.inputs[0].txid, vout: f.pending.plan.inputs[0].vout, spentByTxid: 'd'.repeat(64) }];
    expect(isPendingTransferReconciled(f.snapshot, f.pending, f.owned)).toBe(false);
    f.snapshot.history.push({ txid: 'd'.repeat(64), deltaUnits: '-5000000', feeUnits: '200', status: 'conflicted', confirmations: 0, blockHeight: null, timestamp: 2 });
    expect(isPendingTransferReconciled(f.snapshot, f.pending, f.owned)).toBe(false);
    f.snapshot.history.at(-1)!.status = 'confirmed'; f.snapshot.history.at(-1)!.confirmations = 1; f.snapshot.history.at(-1)!.blockHeight = 500;
    f.snapshot.complete = false;
    expect(isPendingTransferReconciled(f.snapshot, f.pending, f.owned)).toBe(false);
  });
  it('retains an original conflicted receipt while the competing spend is only pending', () => {
    const f = fixture(); f.snapshot.utxos = [];
    f.snapshot.history.push({ txid: f.pending.signed.txid, deltaUnits: '-1000000', feeUnits: f.pending.plan.feeUnits,
      status: 'conflicted', confirmations: 0, blockHeight: null, timestamp: 2 });
    f.snapshot.history.push({ txid: 'd'.repeat(64), deltaUnits: '-5000000', feeUnits: '200',
      status: 'pending', confirmations: 0, blockHeight: null, timestamp: 3 });
    f.snapshot.spentOutpoints = [{ txid: f.pending.plan.inputs[0].txid, vout: f.pending.plan.inputs[0].vout, spentByTxid: 'd'.repeat(64) }];
    expect(isPendingTransferReconciled(f.snapshot, f.pending, f.owned)).toBe(false);
    expect(reconcilePendingTransfers(f.snapshot, [f.pending], f.owned).utxos).toEqual([]);
  });
  it('rejects modified raw, review amount, fee, unowned change and wrong network', () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => { f.pending.signed.rawHex += '00'; },
      (f: ReturnType<typeof fixture>) => { f.pending.plan.amountUnits = '1000001'; },
      (f: ReturnType<typeof fixture>) => { f.pending.plan.feeUnits = '1'; },
      (f: ReturnType<typeof fixture>) => { f.owned = [f.receive]; },
      (f: ReturnType<typeof fixture>) => { f.snapshot.network.network = 'regtest'; },
    ]) {
      const f = fixture(); mutate(f);
      expect(() => reconcilePendingTransfers(f.snapshot, [f.pending], f.owned)).toThrow();
    }
  });
});
