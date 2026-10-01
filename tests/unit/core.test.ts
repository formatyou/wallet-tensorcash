import { describe, it, expect } from 'vitest';
import { Transaction, p2pkh } from '@scure/btc-signer';
import { hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { deriveAccount, deriveAddress, createMetadata, normalizeMnemonic } from '../../src/core/keys';
import { ACCOUNT_PATH, NETWORKS } from '../../src/core/network';
import { parseUnits, feeForVsize } from '../../src/core/amount';
import { quoteNativeSendMax } from '../../src/core/fees';
import { decodeNativeTransaction, prepareNativeTransfer, signNativeTransfer, PLAN_TTL_MS } from '../../src/core/transactions';
import type { SpendRequest, Utxo, WalletNetwork } from '../../src/shared/types';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
function fixture(amount = 1_000_000n, index = 0, network: WalletNetwork = 'regtest') {
  const account = deriveAccount(MNEMONIC, network); const receive = deriveAddress(account, network, 0, index); const change = deriveAddress(account, network, 1, 0); const recipient = deriveAddress(account, network, 0, 20);
  const parent = new Transaction({ version: 2, allowUnknownInputs: true }); parent.addInput({ txid: '11'.repeat(32), index, sequence: 0xffffffff }); parent.addOutput({ amount, script: hex.decode(receive.scriptHex) });
  const rawParent = hex.encode(parent.toBytes(true, false)); const decoded = decodeNativeTransaction(rawParent);
  const utxo: Utxo = { txid: decoded.txid, vout: 0, address: receive.address, scriptHex: receive.scriptHex, amountUnits: String(amount), confirmations: 5, blockHeight: 100, coinbase: false, classification: 'native', rawParent, verified: true };
  const request: SpendRequest = { network, recipient: recipient.address, amountUnits: '500000', feeRate: '2', utxos: [utxo], ownedAddresses: [receive], change };
  return { account, receive, change, recipient, utxo, request, metadata: createMetadata(account, network, true), parent };
}
describe('native TensorCash signer', () => {
  it('derives distinct deterministic branches with explicit network and path', () => {
    const f = fixture(); const restored = deriveAccount(MNEMONIC, 'regtest');
    expect(deriveAddress(restored, 'regtest', 0, 0)).toEqual(f.receive);
    expect(f.receive.path).toBe(`${ACCOUNT_PATH}/0/0`); expect(f.change.path).toBe(`${ACCOUNT_PATH}/1/0`);
    expect(f.receive.address).toMatch(/^bcrt1q/); expect(f.change.address).not.toBe(f.receive.address);
    const main = deriveAccount(MNEMONIC, 'mainnet'); const mainAddress = deriveAddress(main, 'mainnet', 0, 0);
    expect(mainAddress.address).toMatch(/^tc1q/); expect(mainAddress.scriptHex).toBe(f.receive.scriptHex); expect(main.publicExtendedKey).not.toBe(restored.publicExtendedKey);
    main.wipePrivateData(); restored.wipePrivateData(); f.account.wipePrivateData();
  });
  it('reports recovery word count, position and checksum without exposing the phrase', () => {
    expect(normalizeMnemonic(`  ${MNEMONIC.toUpperCase().replaceAll(' ', '\n')}  `)).toBe(MNEMONIC);
    expect(() => normalizeMnemonic('')).toThrow('You entered 0.');
    expect(() => normalizeMnemonic(MNEMONIC.split(' ').slice(1).join(' '))).toThrow('You entered 11.');
    expect(() => normalizeMnemonic(MNEMONIC.replace('abandon', 'abandno'))).toThrow('Recovery word 1 is not in the English word list.');
    expect(() => normalizeMnemonic('abandon '.repeat(11) + 'abandon')).toThrow('checksum is invalid');
    expect(() => normalizeMnemonic('abandon '.repeat(150))).toThrow('phrase is too long');
  });
  it('rejects mnemonic checksum and unsupported path inputs', () => {
    expect(() => normalizeMnemonic('abandon '.repeat(12))).toThrow(); const f = fixture(); expect(() => deriveAddress(f.account, 'regtest', 0, -1)).toThrow(); expect(() => deriveAddress(f.account, 'regtest', 2 as 0, 0)).toThrow(); f.account.wipePrivateData();
  });
  it('uses exact decimal fee arithmetic and rejects floating amounts', () => {
    expect(feeForVsize('1.001', 141)).toBe(142n); expect(parseUnits('2100000000000000')).toBe(2100000000000000n);
    for (const invalid of ['0.1', '001', '1e8', '-1', '2100000000000001']) expect(() => parseUnits(invalid)).toThrow();
  });
  it('signs a PSBT v0 locally with checked txid/vsize/fee and internal change', () => {
    const f = fixture(); const prepared = prepareNativeTransfer(f.request, f.account, f.metadata); const psbt = Transaction.fromPSBT(hex.decode(prepared.psbtHex));
    expect(psbt.outputsLength).toBe(2); expect(psbt.getOutputAddress(1, NETWORKS.regtest.bitcoin)).toBe(f.change.address);
    const signed = signNativeTransfer(prepared, f.account); const decoded = decodeNativeTransaction(signed.rawHex);
    expect(decoded.txid).toBe(signed.txid); expect(decoded.wtxid).not.toBe(decoded.txid); expect(signed.feeUnits).toBe(prepared.plan.feeUnits);
    expect(signed.vsize).toBeLessThanOrEqual(prepared.plan.estimatedVsize); expect(BigInt(signed.feeUnits)).toBeGreaterThanOrEqual(feeForVsize('2', signed.vsize));
    expect(decoded.outputs.map(o => o.amountUnits)).toEqual([prepared.plan.amountUnits, prepared.plan.changeUnits]);
    const parsed = Transaction.fromRaw(hex.decode(signed.rawHex)); expect(parsed.id).toBe(signed.txid); expect(parsed.inputsLength).toBe(1); f.account.wipePrivateData();
  });
  it('selects and signs several verified inputs and sends max without change', () => {
    const f = fixture(300_000n); const second = fixture(310_000n, 1); f.request.utxos.push(second.utxo); f.request.ownedAddresses.push(second.receive);
    const prepared = prepareNativeTransfer(f.request, f.account, f.metadata); expect(prepared.plan.inputCount).toBe(2); expect(signNativeTransfer(prepared, f.account).vsize).toBeGreaterThan(140);
    f.request.sendMax = true; f.request.amountUnits = '0'; const max = prepareNativeTransfer(f.request, f.account, f.metadata); expect(max.plan.changeAddress).toBeNull();
    expect(BigInt(max.plan.amountUnits) + BigInt(max.plan.feeUnits)).toBe(610_000n); expect(decodeNativeTransaction(signNativeTransfer(max, f.account).rawHex).outputs).toHaveLength(1); f.account.wipePrivateData(); second.account.wipePrivateData();
  });
  it.each(['1', '2', '15', '1.001'])('shows the same maximum and fee that are actually signed at rate %s', rate => {
    const f = fixture(2_000_000n); const second = fixture(3_000_000n, 1); const third = fixture(4_000_000n, 2);
    try {
      f.request.utxos.push(second.utxo, third.utxo); f.request.ownedAddresses.push(second.receive, third.receive);
      Object.assign(f.request, { sendMax: true, amountUnits: '0', feeRate: rate });
      const quote = quoteNativeSendMax(f.request.utxos, rate);
      const prepared = prepareNativeTransfer(f.request, f.account, f.metadata);
      expect(prepared.plan).toMatchObject(quote);
      const signed = signNativeTransfer(prepared, f.account);
      const decoded = decodeNativeTransaction(signed.rawHex);
      expect(decoded.outputs).toHaveLength(1);
      expect(decoded.outputs[0].amountUnits).toBe(quote.amountUnits);
      expect(BigInt(quote.amountUnits) + BigInt(signed.feeUnits)).toBe(9_000_000n);
      expect(BigInt(signed.feeUnits)).toBeGreaterThanOrEqual(feeForVsize(rate, signed.vsize));
    } finally { f.account.wipePrivateData(); second.account.wipePrivateData(); third.account.wipePrivateData(); }
  });
  it('spends mainnet funds after the configured two confirmations and rejects one', () => {
    const f = fixture(1_000_000n, 0, 'mainnet');
    try {
      f.request.sendMax = true; f.request.amountUnits = '0';
      f.request.utxos[0].confirmations = 1;
      expect(() => prepareNativeTransfer(f.request, f.account, f.metadata)).toThrow(/unconfirmed/);
      f.request.utxos[0].confirmations = 2;
      const prepared = prepareNativeTransfer(f.request, f.account, f.metadata);
      expect(decodeNativeTransaction(signNativeTransfer(prepared, f.account).rawHex).outputs).toHaveLength(1);
    } finally { f.account.wipePrivateData(); }
  });
  it('cannot change a reviewed recipient, inputs, outputs, or fee', () => {
    const f = fixture(); for (const field of ['recipient', 'amountUnits', 'feeUnits'] as const) { const prepared = prepareNativeTransfer(f.request, f.account, f.metadata); prepared.plan[field] = field === 'recipient' ? f.change.address : '1'; expect(() => signNativeTransfer(prepared, f.account)).toThrow(/modified/); }
    const prepared = prepareNativeTransfer(f.request, f.account, f.metadata); prepared.selected[0].utxo.amountUnits = '2000000'; expect(() => signNativeTransfer(prepared, f.account)).toThrow(/modified/); f.account.wipePrivateData();
  });
  it('independently re-derives change even if an external caller recomputes a public plan checksum', () => {
    const f = fixture(); const otherAccount = deriveAccount('legal winner thank year wave sausage worth useful legal winner thank yellow', 'regtest');
    const alien = deriveAddress(otherAccount, 'regtest', 1, 0); const prepared = prepareNativeTransfer(f.request, f.account, f.metadata);
    const tx = Transaction.fromPSBT(hex.decode(prepared.psbtHex)); tx.updateOutput(1, { script: hex.decode(alien.scriptHex) });
    prepared.change = alien; prepared.plan.changeAddress = alien.address; prepared.psbtHex = hex.encode(tx.toPSBT(0));
    const { commitment: _, ...rest } = prepared; prepared.commitment = hex.encode(sha256(new TextEncoder().encode(JSON.stringify(rest))));
    expect(() => signNativeTransfer(prepared, f.account)).toThrow(/Owned address/); f.account.wipePrivateData(); otherAccount.wipePrivateData();
  });
  it('expires reviewed plans and requires backup confirmation', () => {
    const f = fixture(); const now = Date.now(); const prepared = prepareNativeTransfer(f.request, f.account, f.metadata, now); expect(() => signNativeTransfer(prepared, f.account, now + PLAN_TTL_MS + 1)).toThrow(/expired/);
    expect(() => prepareNativeTransfer(f.request, f.account, { ...f.metadata, backupConfirmed: false })).toThrow(/backup/); f.account.wipePrivateData();
  });
  it('rejects poisoned parent amounts, txids, scripts and network', () => {
    const f = fixture(); for (const mutation of [{ amountUnits: '2000000' }, { txid: '22'.repeat(32) }, { scriptHex: f.change.scriptHex }]) { const request = structuredClone(f.request); Object.assign(request.utxos[0], mutation); expect(() => prepareNativeTransfer(request, f.account, f.metadata)).toThrow(/match/); }
    expect(() => prepareNativeTransfer({ ...f.request, recipient: deriveAddress(deriveAccount(MNEMONIC, 'mainnet'), 'mainnet', 0, 1).address }, f.account, f.metadata)).toThrow(/network/);
    expect(() => prepareNativeTransfer({ ...f.request, change: f.receive }, f.account, f.metadata)).toThrow(/internal/); f.account.wipePrivateData();
  });
  it('rejects duplicate, unknown, low-confirmation and immature coinbase inputs', () => {
    const f = fixture(); const request = structuredClone(f.request); request.utxos.push(request.utxos[0]); expect(() => prepareNativeTransfer(request, f.account, f.metadata)).toThrow(/Duplicate/);
    for (const mutation of [{ classification: 'unsupported' }, { verified: false }, { confirmations: 0 }]) { const bad = structuredClone(f.request); Object.assign(bad.utxos[0], mutation); expect(() => prepareNativeTransfer(bad, f.account, f.metadata)).toThrow(); }
    const cb = new Transaction({ version: 2, allowUnknownInputs: true }); cb.addOutput({ amount: 1_000_000n, script: hex.decode(f.receive.scriptHex) }); cb.addInput({ txid: '00'.repeat(32), index: 0xffffffff, finalScriptSig: new Uint8Array([1, 1]) });
    const rawParent = hex.encode(cb.toBytes(true, false)); const decoded = decodeNativeTransaction(rawParent); const bad = structuredClone(f.request); Object.assign(bad.utxos[0], { rawParent, txid: decoded.txid, coinbase: true, confirmations: 99 });
    expect(() => prepareNativeTransfer(bad, f.account, f.metadata)).toThrow(/immature/); f.account.wipePrivateData();
  });
  it('blocks excessive fees and dust amounts', () => {
    const f = fixture(10_000n); f.request.amountUnits = '5000'; f.request.feeRate = '1000'; expect(() => prepareNativeTransfer(f.request, f.account, f.metadata)).toThrow();
    f.request.feeRate = '2'; f.request.amountUnits = '1'; expect(() => prepareNativeTransfer(f.request, f.account, f.metadata)).toThrow(/dust/); f.account.wipePrivateData();
  });
  it('rejects legacy recipient addresses before creating a signed transfer', () => {
    const f = fixture(); const address = p2pkh(f.account.publicKey!, NETWORKS.regtest.bitcoin).address!;
    expect(() => prepareNativeTransfer({ ...f.request, recipient: address }, f.account, f.metadata)).toThrow(/only native P2WPKH/); f.account.wipePrivateData();
  });
});
describe('strict native raw decoder', () => {
  it('hashes parents independently of the signing library', () => { const f = fixture(); expect(decodeNativeTransaction(f.utxo.rawParent!).txid).toBe(f.parent.id); f.account.wipePrivateData(); });
  it('rejects truncated, trailing, extension and unknown version bytes', () => {
    const f = fixture(); const raw = f.utxo.rawParent!;
    expect(() => decodeNativeTransaction(raw.slice(0, -2))).toThrow(); expect(() => decodeNativeTransaction(raw + '00')).toThrow(/Trailing/);
    expect(() => decodeNativeTransaction(raw.slice(0, 8) + '0002' + raw.slice(8))).toThrow(/extensions/);
    expect(() => decodeNativeTransaction('00000040' + raw.slice(8))).toThrow(/version/);
    expect(() => decodeNativeTransaction(raw.slice(0, 8) + 'fd0100' + raw.slice(10))).toThrow(/Noncanonical/); f.account.wipePrivateData();
  });
});
