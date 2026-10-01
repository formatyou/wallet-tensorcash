import { afterEach, describe, expect, it } from 'vitest';
import { Transaction } from '@scure/btc-signer';
import { hex } from '@scure/base';
import type { HDKey } from '@scure/bip32';
import type { SpendRequest, Utxo } from '../../src/shared/types';
import { createMetadata, deriveAccount, deriveAddress } from '../../src/core/keys';
import { feeForVsize } from '../../src/core/amount';
import { dustThreshold, estimateP2wpkhVsize, MAX_INPUTS, quoteNativeSendMax } from '../../src/core/fees';
import { decodeNativeTransaction, prepareNativeTransfer, signNativeTransfer } from '../../src/core/transactions';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const accounts: HDKey[] = [];
afterEach(() => { for (const account of accounts) account.wipePrivateData(); accounts.length = 0; });
function wallet(values: bigint[], amount = '500000', rate = '2') {
  const account = deriveAccount(PHRASE, 'regtest'); accounts.push(account);
  const receive = deriveAddress(account, 'regtest', 0, 0); const change = deriveAddress(account, 'regtest', 1, 0);
  const recipient = deriveAddress(account, 'regtest', 0, 20);
  const parent = new Transaction({ version: 2, allowUnknownInputs: true });
  parent.addInput({ txid: '11'.repeat(32), index: 0, sequence: 0xffffffff });
  for (const value of values) parent.addOutput({ amount: value, script: hex.decode(receive.scriptHex) });
  const rawParent = hex.encode(parent.toBytes(true, false)); const txid = decodeNativeTransaction(rawParent).txid;
  const utxos: Utxo[] = values.map((value, vout) => ({ txid, vout, address: receive.address, scriptHex: receive.scriptHex,
    amountUnits: String(value), confirmations: 5, blockHeight: 100, coinbase: false, classification: 'native', verified: true, rawParent }));
  const request: SpendRequest = { network: 'regtest', recipient: recipient.address, amountUnits: amount, feeRate: rate,
    utxos, ownedAddresses: [receive], change };
  const metadata = createMetadata(account, 'regtest', true);
  return { account, request, metadata, recipient, change };
}
function signed(f: ReturnType<typeof wallet>) {
  const prepared = prepareNativeTransfer(f.request, f.account, f.metadata);
  const transfer = signNativeTransfer(prepared, f.account);
  const tx = decodeNativeTransaction(transfer.rawHex);
  expect(BigInt(transfer.feeUnits)).toBeGreaterThanOrEqual(feeForVsize(f.request.feeRate, tx.vsize));
  expect(BigInt(prepared.plan.amountUnits) + BigInt(prepared.plan.changeUnits) + BigInt(prepared.plan.feeUnits))
    .toBe(prepared.selected.reduce((total, input) => total + BigInt(input.utxo.amountUnits), 0n));
  return { prepared, transfer, tx };
}
describe('ordinary payments preserve other confirmed outputs', () => {
  it('spends the sufficient middle-sized output and leaves larger and smaller outputs untouched', () => {
    const f = wallet([9_000_000n, 1_000_000n, 100_000n]);
    const { prepared, tx } = signed(f);
    expect(prepared.plan.inputs).toEqual([{ txid: f.request.utxos[1].txid, vout: 1, amountUnits: '1000000' }]);
    expect(tx.inputs).toHaveLength(1); expect(tx.inputs[0].vout).toBe(1);
    expect(prepared.plan.changeAddress).toBe(f.change.address);
    expect(prepared.plan.changeUnits).toBe(String(1_000_000n - 500_000n - BigInt(prepared.plan.feeUnits)));
  });
  it('uses the smaller sufficient owned output for the reported 0.001 TSC payment', () => {
    // Public incident: the old selector spent 2,699,577 units for 100,000 units
    // plus a 141-unit fee. A 400,000-unit output would cover the same payment
    // when its ownership and spendability are established independently.
    const f = wallet([2_699_577n, 400_000n, 50_000n], '100000', '1');
    const { prepared, tx } = signed(f);
    expect(prepared.plan.inputs.map(input => input.amountUnits)).toEqual(['400000']);
    expect(prepared.plan.feeUnits).toBe('141'); expect(prepared.plan.changeUnits).toBe('299859');
    expect(tx.outputs.map(output => output.amountUnits)).toEqual(['100000', '299859']);
  });
  it('never picks an output that covers the amount but is one unit short of its fee', () => {
    const noChangeFee = feeForVsize('2', estimateP2wpkhVsize(1, [new Uint8Array(22)]));
    const f = wallet([500_000n, 500_000n + noChangeFee - 1n, 750_000n, 3_000_000n]);
    const { prepared } = signed(f);
    expect(prepared.plan.inputs).toEqual([{ txid: f.request.utxos[2].txid, vout: 2, amountUnits: '750000' }]);
  });
  it('prefers an exact single output without change even when much larger inputs are available', () => {
    const noChangeFee = feeForVsize('1.001', estimateP2wpkhVsize(1, [new Uint8Array(22)]));
    const f = wallet([5_000_000n, 500_000n + noChangeFee, 1_000_000n], '500000', '1.001');
    const { prepared, tx } = signed(f);
    expect(prepared.plan.inputs[0].vout).toBe(1); expect(prepared.plan.changeAddress).toBeNull();
    expect(prepared.plan.changeUnits).toBe('0'); expect(prepared.plan.feeUnits).toBe(String(noChangeFee)); expect(tx.outputs).toHaveLength(1);
  });
  it('respects the exact change dust boundary and safely absorbs only sub-dust change', () => {
    const script = new Uint8Array(22); const withChangeFee = feeForVsize('2', estimateP2wpkhVsize(1, [script, script]));
    const dust = dustThreshold(script, '2');
    for (const remainder of [dust - 1n, dust]) {
      const f = wallet([4_000_000n, 500_000n + withChangeFee + remainder]);
      const { prepared, tx } = signed(f);
      expect(prepared.plan.inputs[0].vout).toBe(1);
      expect(prepared.plan.changeUnits).toBe(remainder === dust ? String(dust) : '0');
      expect(tx.outputs).toHaveLength(remainder === dust ? 2 : 1);
      expect(prepared.plan.feeUnits).toBe(String(remainder === dust ? withChangeFee : withChangeFee + remainder));
    }
  });
  it('skips a funded small output whose fee exceeds the 5% safety cap', () => {
    const f = wallet([1000n, 2000n, 3000n, 1_000_000n], '600', '1');
    const { prepared } = signed(f);
    expect(prepared.plan.inputCount).toBe(1); expect(prepared.plan.inputs[0].amountUnits).toBe('3000');
    expect(BigInt(prepared.plan.feeUnits) * 20n).toBeLessThanOrEqual(3000n);
  });
  it('chooses deterministically among equal values and does not depend on provider order', () => {
    const f = wallet([1_000_000n, 1_000_000n, 2_000_000n, 100_000n]);
    const expected = signed(f).prepared.plan.inputs;
    f.request.utxos.reverse(); const reversed = signed(f).prepared.plan.inputs;
    expect(reversed).toEqual(expected); expect(expected[0].vout).toBe(0);
  });
  it('falls back to the fewest large inputs instead of consolidating many small outputs', () => {
    const f = wallet([100_000n, 400_000n, 100_000n, 450_000n, 100_000n], '700000');
    const { prepared, tx } = signed(f);
    expect(prepared.plan.inputCount).toBe(2); expect(prepared.plan.inputs.map(input => input.amountUnits)).toEqual(['450000', '400000']);
    expect(tx.inputs).toHaveLength(2);
  });
  it('keeps Max consuming every eligible output with the same quote and no change', () => {
    const f = wallet([9_000_000n, 1_000_000n, 100_000n]); f.request.sendMax = true; f.request.amountUnits = '0';
    const quote = quoteNativeSendMax(f.request.utxos, f.request.feeRate); const { prepared, tx } = signed(f);
    expect(prepared.plan).toMatchObject(quote); expect(prepared.plan.inputCount).toBe(3);
    expect(prepared.plan.inputs.map(input => input.amountUnits)).toEqual(['9000000', '1000000', '100000']);
    expect(prepared.plan.changeAddress).toBeNull(); expect(tx.outputs).toHaveLength(1);
  });
  it('keeps the 100-input ceiling for normal payments and rejects Max above it', () => {
    const f = wallet(Array.from({ length: MAX_INPUTS + 1 }, () => 100_000n), '9990000');
    expect(() => prepareNativeTransfer(f.request, f.account, f.metadata)).toThrow(/cannot cover/);
    f.request.amountUnits = '9980000';
    expect(prepareNativeTransfer(f.request, f.account, f.metadata).plan.inputCount).toBe(MAX_INPUTS);
    f.request.sendMax = true; f.request.amountUnits = '0';
    expect(() => prepareNativeTransfer(f.request, f.account, f.metadata)).toThrow(/input-count/);
  });
  it('still rejects absolute fee cap violations, underfunding and recipient dust', () => {
    const excessive = wallet(Array.from({ length: 100 }, () => 10_000_000n), '990000000', '1000');
    expect(() => prepareNativeTransfer(excessive.request, excessive.account, excessive.metadata)).toThrow(/absolute/);
    const insufficient = wallet([100_000n, 150_000n]);
    expect(() => prepareNativeTransfer(insufficient.request, insufficient.account, insufficient.metadata)).toThrow(/cannot cover/);
    const dust = wallet([500_000n, 1_000_000n], '1');
    expect(() => prepareNativeTransfer(dust.request, dust.account, dust.metadata)).toThrow(/dust/);
  });
});
