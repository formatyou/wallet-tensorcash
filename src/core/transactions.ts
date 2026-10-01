import { Transaction, Address, OutScript, SigHash } from '@scure/btc-signer';
import { HDKey } from '@scure/bip32';
import { hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import type { AddressRecord, SpendRequest, TransferPlan, SignedTransfer, Utxo, WalletMetadata } from '../shared/types';
import { deriveAddress } from './keys';
import { feeForVsize, parseRate, parseUnits, MAX_UNITS } from './amount';
import { dustThreshold, estimateP2wpkhVsize, feeCaps, MAX_INPUTS, quoteNativeSendMax } from './fees';
import { networkConfig } from './network';
import { decodeNativeTransaction } from './raw';
export { decodeNativeTransaction } from './raw';

export const PLAN_TTL_MS = 120_000;
export { MAX_FEE_UNITS, MAX_INPUTS, estimateP2wpkhVsize } from './fees';
export interface PreparedTransfer { plan: TransferPlan; psbtHex: string; selected: { utxo: Utxo; record: AddressRecord }[]; change: AddressRecord; expiresAt: number; commitment: string; }
const stable = (value: unknown): string => JSON.stringify(value);
const commit = (prepared: Omit<PreparedTransfer, 'commitment'>) => hex.encode(sha256(new TextEncoder().encode(stable(prepared))));
function outputScript(address: string, network: SpendRequest['network']): Uint8Array {
  if (typeof address !== 'string' || address.length > 100) throw new Error('Invalid recipient address');
  let parsed; try { parsed = Address(networkConfig(network).bitcoin).decode(address); } catch { throw new Error('Invalid recipient address or wrong network'); }
  if (parsed.type !== 'wpkh') throw new Error('This release supports only native P2WPKH recipient addresses');
  const script = OutScript.encode(parsed);
  if (Address(networkConfig(network).bitcoin).encode(parsed).toLowerCase() !== address.toLowerCase()) throw new Error('Noncanonical recipient address');
  return script;
}
function validateRecord(record: AddressRecord, account: HDKey, network: SpendRequest['network']): AddressRecord {
  if (!record || typeof record !== 'object') throw new Error('Invalid owned address');
  const expected = deriveAddress(account, network, record.branch, record.index);
  if (expected.address !== record.address || expected.scriptHex !== record.scriptHex || expected.path !== record.path) throw new Error('Owned address derivation was changed');
  return expected;
}
export function verifyNativeUtxo(utxo: Utxo, record: AddressRecord, minConfirmations = 1): void {
  if (!utxo || !/^[a-f0-9]{64}$/.test(utxo.txid) || !Number.isSafeInteger(utxo.vout) || utxo.vout < 0 || utxo.vout > 1999 || !Number.isSafeInteger(utxo.confirmations) || utxo.confirmations < minConfirmations) throw new Error('Invalid or unconfirmed input');
  if (!utxo.verified || utxo.classification !== 'native' || typeof utxo.rawParent !== 'string') throw new Error('Input is not verified native TSC');
  const parent = decodeNativeTransaction(utxo.rawParent);
  const output = parent.outputs[utxo.vout];
  if (parent.txid !== utxo.txid || !output || output.amountUnits !== utxo.amountUnits || output.scriptHex !== utxo.scriptHex || record.scriptHex !== utxo.scriptHex || record.address !== utxo.address) throw new Error('Parent transaction does not match input');
  if (utxo.coinbase !== parent.coinbase || (parent.coinbase && utxo.confirmations < 100)) throw new Error('Coinbase is immature or misclassified');
  parseUnits(utxo.amountUnits, false);
}
export function prepareNativeTransfer(request: SpendRequest, account: HDKey, metadata: WalletMetadata, now = Date.now()): PreparedTransfer {
  if (!metadata.backupConfirmed) throw new Error('Confirm your backup before sending');
  if (request.network !== metadata.network || metadata.accountXpub !== account.publicExtendedKey) throw new Error('Transfer belongs to another wallet or network');
  networkConfig(request.network); parseRate(request.feeRate);
  const recipientScript = outputScript(request.recipient, request.network);
  if (!Array.isArray(request.ownedAddresses) || request.ownedAddresses.length > 2000 || !Array.isArray(request.utxos) || request.utxos.length > 2000) throw new Error('Too many address or input candidates');
  const records = new Map<string, AddressRecord>();
  for (const record of request.ownedAddresses) { const expected = validateRecord(record, account, request.network); if (records.has(expected.address)) throw new Error('Duplicate owned address'); records.set(expected.address, expected); }
  const change = validateRecord(request.change, account, request.network);
  if (change.branch !== 1) throw new Error('Change must use the internal address branch');
  const changeScript = hex.decode(change.scriptHex);
  const candidates: PreparedTransfer['selected'] = []; const seen = new Set<string>(); let inventory = 0n;
  for (const utxo of request.utxos) {
    const key = `${utxo.txid}:${utxo.vout}`;
    if (seen.has(key)) throw new Error('Duplicate input candidate'); seen.add(key);
    const record = records.get(utxo.address);
    if (!record || !utxo.verified || utxo.classification !== 'native') continue;
    verifyNativeUtxo(utxo, record, request.network === 'mainnet' ? 2 : 1);
    inventory += parseUnits(utxo.amountUnits, false); if (inventory > MAX_UNITS) throw new Error('Input inventory exceeds permitted amount');
    candidates.push({ utxo: structuredClone(utxo), record });
  }
  candidates.sort((a, b) => { const av = BigInt(a.utxo.amountUnits); const bv = BigInt(b.utxo.amountUnits); return av === bv ? `${a.utxo.txid}:${a.utxo.vout}`.localeCompare(`${b.utxo.txid}:${b.utxo.vout}`) : av > bv ? -1 : 1; });
  if (!candidates.length) throw new Error('No verified spendable native inputs');
  let amount = parseUnits(request.amountUnits, !!request.sendMax); let total = 0n; let fee = 0n; let changeUnits = 0n; let estimatedVsize = 0;
  const selected: PreparedTransfer['selected'] = [];
  if (request.sendMax) {
    selected.push(...candidates); total = inventory;
    const quote = quoteNativeSendMax(selected.map(({ utxo }) => utxo), request.feeRate);
    estimatedVsize = quote.estimatedVsize; fee = BigInt(quote.feeUnits); amount = BigInt(quote.amountUnits);
  } else {
    if (amount <= 0n) throw new Error('Send amount must be positive');
    let feeFailure: Error | null = null;
    const quote = (inputTotal: bigint, inputCount: number) => {
      const withChangeSize = estimateP2wpkhVsize(inputCount, [recipientScript, changeScript]);
      const withChangeFee = feeForVsize(request.feeRate, withChangeSize);
      const remainder = inputTotal - amount - withChangeFee;
      let result: { fee: bigint; changeUnits: bigint; estimatedVsize: number };
      if (remainder >= dustThreshold(changeScript, request.feeRate)) {
        result = { fee: withChangeFee, changeUnits: remainder, estimatedVsize: withChangeSize };
      } else {
        const noChangeSize = estimateP2wpkhVsize(inputCount, [recipientScript]);
        if (inputTotal < amount + feeForVsize(request.feeRate, noChangeSize)) return null;
        result = { fee: inputTotal - amount, changeUnits: 0n, estimatedVsize: noChangeSize };
      }
      try { feeCaps(result.fee, inputTotal); }
      catch (failure) { feeFailure = failure as Error; return null; }
      return result;
    };
    // Preserve other confirmed outputs for subsequent payments. An output that
    // covers only the recipient amount, but not its fee policy, is insufficient.
    const smallestFirst = [...candidates].sort((a, b) => {
      const av = BigInt(a.utxo.amountUnits); const bv = BigInt(b.utxo.amountUnits);
      return av === bv ? `${a.utxo.txid}:${a.utxo.vout}`.localeCompare(`${b.utxo.txid}:${b.utxo.vout}`) : av < bv ? -1 : 1;
    });
    for (const candidate of smallestFirst) {
      const candidateTotal = BigInt(candidate.utxo.amountUnits);
      const single = quote(candidateTotal, 1);
      if (!single) continue;
      selected.push(candidate); total = candidateTotal;
      ({ fee, changeUnits, estimatedVsize } = single); break;
    }
    // When no single output can fund the payment, largest-first minimizes the
    // number of inputs needed. Max continues to consume the entire inventory.
    if (!selected.length) for (const candidate of candidates) {
      if (selected.length >= MAX_INPUTS) break;
      selected.push(candidate); total += BigInt(candidate.utxo.amountUnits);
      const multiple = quote(total, selected.length);
      if (multiple) { ({ fee, changeUnits, estimatedVsize } = multiple); break; }
    }
    if (!estimatedVsize) {
      if (feeFailure) throw feeFailure;
      throw new Error('Available funds cannot cover this amount and the network fee. Pending funds are excluded. Use Max to send the available balance.');
    }
  }
  if (amount < dustThreshold(recipientScript, request.feeRate)) throw new Error('Recipient amount is below safe dust threshold');
  feeCaps(fee, total);
  const tx = new Transaction({ version: 2, lockTime: 0, PSBTVersion: 0, strictPrevoutValidation: true });
  for (const { utxo } of selected) tx.addInput({ txid: utxo.txid, index: utxo.vout, sequence: 0xffffffff, sighashType: SigHash.ALL, witnessUtxo: { amount: BigInt(utxo.amountUnits), script: hex.decode(utxo.scriptHex) }, nonWitnessUtxo: hex.decode(utxo.rawParent!) });
  tx.addOutput({ script: recipientScript, amount }); if (changeUnits) tx.addOutput({ script: changeScript, amount: changeUnits });
  const plan: TransferPlan = { id: crypto.randomUUID(), network: request.network, recipient: request.recipient, amountUnits: String(amount), feeUnits: String(fee), feeRate: request.feeRate, changeAddress: changeUnits ? change.address : null, changeUnits: String(changeUnits), inputCount: selected.length, inputs: selected.map(({ utxo }) => ({ txid: utxo.txid, vout: utxo.vout, amountUnits: utxo.amountUnits })), estimatedVsize, createdAt: new Date(now).toISOString() };
  const prepared = { plan, psbtHex: hex.encode(tx.toPSBT(0)), selected, change, expiresAt: now + PLAN_TTL_MS };
  return { ...prepared, commitment: commit(prepared) };
}
export function signNativeTransfer(prepared: PreparedTransfer, account: HDKey, now = Date.now()): SignedTransfer {
  const { commitment, ...committed } = prepared;
  if (commit(committed) !== commitment) throw new Error('Reviewed transfer was modified');
  if (now > prepared.expiresAt || now < Date.parse(prepared.plan.createdAt) - 1000) throw new Error('Reviewed transfer expired');
  const { plan, selected } = prepared;
  const tx = Transaction.fromPSBT(hex.decode(prepared.psbtHex), { strictPrevoutValidation: true });
  if (tx.version !== 2 || tx.lockTime !== 0 || tx.inputsLength !== plan.inputCount || tx.inputsLength !== selected.length || tx.outputsLength !== (plan.changeAddress ? 2 : 1)) throw new Error('Transaction structure differs from review');
  let total = 0n;
  selected.forEach(({ utxo, record }, index) => {
    validateRecord(record, account, plan.network); verifyNativeUtxo(utxo, record, plan.network === 'mainnet' ? 2 : 1);
    const input = tx.getInput(index); const expected = plan.inputs[index];
    if (hex.encode(input.txid!) !== utxo.txid || input.index !== utxo.vout || input.sighashType !== SigHash.ALL || input.sequence !== 0xffffffff || expected.txid !== utxo.txid || expected.vout !== utxo.vout || expected.amountUnits !== utxo.amountUnits) throw new Error('Input differs from review');
    total += BigInt(utxo.amountUnits);
  });
  const output = tx.getOutput(0);
  if (output.amount !== parseUnits(plan.amountUnits, false) || hex.encode(output.script!) !== hex.encode(outputScript(plan.recipient, plan.network))) throw new Error('Recipient differs from review');
  if (plan.changeAddress) { const change = tx.getOutput(1); const own = validateRecord(prepared.change, account, plan.network);
    if (own.branch !== 1 || own.address !== plan.changeAddress || change.amount !== parseUnits(plan.changeUnits, false) || hex.encode(change.script!) !== own.scriptHex) throw new Error('Change differs from review');
  } else if (plan.changeUnits !== '0') throw new Error('Unexpected change amount');
  const fee = total - BigInt(plan.amountUnits) - BigInt(plan.changeUnits);
  if (fee !== parseUnits(plan.feeUnits, false) || tx.fee !== fee) throw new Error('Fee differs from review'); feeCaps(fee, total);
  selected.forEach(({ record }, index) => { const branch = account.deriveChild(record.branch); const child = branch.deriveChild(record.index); try { if (!child.privateKey || !tx.signIdx(child.privateKey, index, [SigHash.ALL])) throw new Error('Local signature failed'); } finally { child.wipePrivateData(); branch.wipePrivateData(); } });
  tx.finalize(); const rawHex = hex.encode(tx.extract()); const decoded = decodeNativeTransaction(rawHex);
  if (decoded.txid !== tx.id || decoded.vsize !== tx.vsize || decoded.vsize > plan.estimatedVsize || fee < feeForVsize(plan.feeRate, decoded.vsize)) throw new Error('Signed transaction size or fee policy differs');
  return { txid: decoded.txid, rawHex, feeUnits: String(fee), vsize: decoded.vsize };
}
