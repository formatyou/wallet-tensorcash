import { Address, OutScript } from '@scure/btc-signer';
import { hex } from '@scure/base';
import { parseUnits } from '../core/amount';
import { ACCOUNT_PATH, networkConfig } from '../core/network';
import { decodeNativeTransaction } from '../core/raw';
import type { AddressRecord, SignedTransfer, TransferPlan, Utxo, WalletSnapshot } from '../shared/types';

// These records must come only from an accepted/already-known response whose
// txid matched the locally signed transfer. Unknown broadcast outcomes stay in
// the retry journal; they must not manufacture an accepted balance here.
export interface PendingTransfer { plan: TransferPlan; signed: SignedTransfer; }
const key = (txid: string, vout: number) => `${txid}:${vout}`;

function details(snapshot: WalletSnapshot, pending: PendingTransfer, ownedAddresses: AddressRecord[]) {
  const { plan, signed } = pending;
  const network = networkConfig(plan.network);
  if (snapshot.network.network !== plan.network || snapshot.network.genesisHash !== network.genesisHash)
    throw new Error('Published transfer belongs to another network');
  const tx = decodeNativeTransaction(signed.rawHex);
  if (tx.txid !== signed.txid || tx.vsize !== signed.vsize || tx.version !== 2 || tx.lockTime !== 0 || tx.coinbase ||
      tx.inputs.length !== plan.inputCount || plan.inputs.length !== plan.inputCount ||
      tx.outputs.length !== (plan.changeAddress ? 2 : 1)) throw new Error('Published transfer differs from its signed review');
  const scriptForAddress = (address: string) => {
    const parsed = Address(network.bitcoin).decode(address);
    if (parsed.type !== 'wpkh') throw new Error('Unsupported published output');
    return hex.encode(OutScript.encode(parsed));
  };
  if (tx.outputs[0].amountUnits !== plan.amountUnits || tx.outputs[0].scriptHex !== scriptForAddress(plan.recipient))
    throw new Error('Published recipient differs from review');
  if (plan.changeAddress) {
    if (tx.outputs[1].amountUnits !== plan.changeUnits || tx.outputs[1].scriptHex !== scriptForAddress(plan.changeAddress))
      throw new Error('Published change differs from review');
  } else if (plan.changeUnits !== '0') throw new Error('Unexpected published change');
  const inputKeys = new Set<string>();
  let total = 0n;
  tx.inputs.forEach((input, index) => {
    const expected = plan.inputs[index]; const outpoint = key(input.txid, input.vout);
    if (inputKeys.has(outpoint) || input.txid !== expected.txid || input.vout !== expected.vout || input.sequence !== 0xffffffff)
      throw new Error('Published inputs differ from review');
    inputKeys.add(outpoint); total += parseUnits(expected.amountUnits, false);
  });
  const fee = total - tx.outputs.reduce((sum, output) => sum + parseUnits(output.amountUnits), 0n);
  if (fee !== parseUnits(plan.feeUnits, false) || signed.feeUnits !== plan.feeUnits || fee > 1_000_000n || fee * 20n > total)
    throw new Error('Published fee differs from review');
  const records = new Map<string, AddressRecord>();
  for (const record of ownedAddresses) {
    if ((record.branch !== 0 && record.branch !== 1) || !Number.isSafeInteger(record.index) || record.index < 0 ||
        record.path !== `${ACCOUNT_PATH}/${record.branch}/${record.index}` || scriptForAddress(record.address) !== record.scriptHex)
      throw new Error('Invalid owned output record');
    records.set(record.scriptHex, record);
  }
  if (plan.changeAddress) {
    const change = records.get(tx.outputs[1].scriptHex);
    if (!change || change.branch !== 1 || change.address !== plan.changeAddress) throw new Error('Published change is not an owned internal address');
  }
  const ownedOutputs = tx.outputs.flatMap(output => {
    const record = records.get(output.scriptHex);
    return record ? [{ output, record }] : [];
  });
  const delta = ownedOutputs.reduce((sum, item) => sum + BigInt(item.output.amountUnits), 0n) - total;
  return { tx, inputKeys, ownedOutputs, delta, fee };
}

function spent(snapshot: WalletSnapshot): Set<string> {
  const active = new Set(snapshot.history.filter(entry => entry.status !== 'conflicted').map(entry => entry.txid));
  const result = new Set<string>();
  for (const item of snapshot.spentOutpoints ?? []) if (active.has(item.spentByTxid)) result.add(key(item.txid, item.vout));
  // A Core-verified current output also corroborates its parent transaction's
  // spends, even if an older server does not yet expose the explicit graph.
  for (const coin of snapshot.utxos) if (coin.verified && coin.classification === 'native' && coin.rawParent) {
    try {
      const tx = decodeNativeTransaction(coin.rawParent);
      const output = tx.outputs[coin.vout];
      if (tx.txid !== coin.txid || !output || output.scriptHex !== coin.scriptHex || output.amountUnits !== coin.amountUnits) continue;
      for (const input of tx.inputs) result.add(key(input.txid, input.vout));
    } catch { /* Unusable public raw data cannot prove an output was spent. */ }
  }
  return result;
}

function conflict(snapshot: WalletSnapshot, txid: string, inputs: Set<string>): 'pending' | 'confirmed' | null {
  if (!snapshot.complete || !snapshot.network.ready) return null;
  let state: 'pending' | 'confirmed' | null = null;
  for (const edge of snapshot.spentOutpoints ?? []) {
    if (edge.spentByTxid === txid || !inputs.has(key(edge.txid, edge.vout))) continue;
    const spender = snapshot.history.find(entry => entry.txid === edge.spentByTxid && entry.status !== 'conflicted');
    if (!spender) continue;
    if (spender.status === 'confirmed' && spender.confirmations > 0 && spender.blockHeight !== null) return 'confirmed';
    if (spender.status === 'pending' && spender.confirmations === 0 && spender.blockHeight === null) state = 'pending';
  }
  return state;
}

export function isPendingTransferReconciled(snapshot: WalletSnapshot, pending: PendingTransfer, ownedAddresses: AddressRecord[]): boolean {
  const info = details(snapshot, pending, ownedAddresses);
  if (!snapshot.complete || !snapshot.network.ready) return false;
  // A canonical confirmed competing spend resolves this local projection even
  // when the address index never observed the original accepted transaction.
  const competing = conflict(snapshot, info.tx.txid, info.inputKeys);
  if (competing === 'confirmed') return true;
  if (competing === 'pending') return false;
  const history = snapshot.history.find(entry => entry.txid === info.tx.txid);
  if (!history || history.deltaUnits !== String(info.delta) || (history.feeUnits !== null && history.feeUnits !== String(info.fee))) return false;
  if (history.status === 'conflicted') return true;
  if (snapshot.utxos.some(coin => info.inputKeys.has(key(coin.txid, coin.vout)))) return false;
  const consumed = spent(snapshot);
  return info.ownedOutputs.every(({ output, record }) => {
    const coin = snapshot.utxos.find(item => item.txid === info.tx.txid && item.vout === output.vout);
    return consumed.has(key(info.tx.txid, output.vout)) || !!coin && coin.address === record.address &&
      coin.scriptHex === output.scriptHex && coin.amountUnits === output.amountUnits && coin.verified && coin.classification === 'native';
  });
}

export function reconcilePendingTransfers(snapshot: WalletSnapshot, pending: PendingTransfer[], ownedAddresses: AddressRecord[]): WalletSnapshot {
  if (!pending.length) return snapshot;
  if (pending.length > 100) throw new Error('Too many locally published transfers');
  const result = structuredClone(snapshot);
  const consumed = spent(snapshot);
  const known = new Set<string>();
  let supplemented = false;
  for (const transfer of pending) {
    const info = details(snapshot, transfer, ownedAddresses);
    if (known.has(info.tx.txid)) continue;
    known.add(info.tx.txid);
    const competing = conflict(snapshot, info.tx.txid, info.inputKeys);
    if (competing) {
      // Never show an original transaction's change when another active
      // transaction spends its inputs. A pending conflict retains the receipt
      // and sending pause, because its current membership can change again.
      result.utxos = result.utxos.filter(coin => coin.txid !== info.tx.txid && !info.inputKeys.has(key(coin.txid, coin.vout)));
      const entry = result.history.find(item => item.txid === info.tx.txid);
      if (entry) { entry.status = 'conflicted'; entry.confirmations = 0; entry.blockHeight = null; }
      else {
        const timestamp = Math.floor(Date.parse(transfer.plan.createdAt) / 1000);
        result.history.push({ txid: info.tx.txid, deltaUnits: String(info.delta), feeUnits: String(info.fee), status: 'conflicted',
          confirmations: 0, blockHeight: null, timestamp: Number.isFinite(timestamp) ? timestamp : null });
      }
      if (competing === 'pending') supplemented = true;
      continue;
    }
    if (isPendingTransferReconciled(snapshot, transfer, ownedAddresses)) continue;
    supplemented = true;
    for (const input of info.inputKeys) consumed.add(input);
    result.utxos = result.utxos.filter(coin => !info.inputKeys.has(key(coin.txid, coin.vout)));
    for (const { output, record } of info.ownedOutputs) {
      const outpoint = key(info.tx.txid, output.vout);
      if (consumed.has(outpoint)) continue;
      const existing = result.utxos.find(coin => key(coin.txid, coin.vout) === outpoint);
      if (existing) {
        if (existing.amountUnits !== output.amountUnits || existing.scriptHex !== output.scriptHex || existing.address !== record.address)
          throw new Error('Provider output differs from the locally signed transaction');
        continue;
      }
      // Identity/ownership/native wire are checked locally, but a local receipt
      // never infers confirmations. This output cannot pass the spending gate.
      const coin: Utxo = { txid: info.tx.txid, vout: output.vout, address: record.address, scriptHex: output.scriptHex,
        amountUnits: output.amountUnits, confirmations: 0, blockHeight: null, coinbase: false,
        classification: 'native', rawParent: transfer.signed.rawHex, verified: true };
      result.utxos.push(coin);
      const activity = result.addresses.find(item => item.address === record.address);
      if (activity) activity.used = true;
      else result.addresses.push({ address: record.address, used: true });
    }
    const existingHistory = result.history.find(item => item.txid === info.tx.txid);
    const timestamp = Math.floor(Date.parse(transfer.plan.createdAt) / 1000);
    if (existingHistory) {
      existingHistory.deltaUnits = String(info.delta); existingHistory.feeUnits = String(info.fee);
    } else result.history.push({ txid: info.tx.txid, deltaUnits: String(info.delta), feeUnits: String(info.fee), status: 'pending',
      confirmations: 0, blockHeight: null, timestamp: Number.isFinite(timestamp) ? timestamp : null });
  }
  // Applying several accepted transactions must not resurrect an output spent
  // by another local receipt, regardless of the records' ordering.
  result.utxos = result.utxos.filter(coin => !consumed.has(key(coin.txid, coin.vout)));
  result.history.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0) || a.txid.localeCompare(b.txid));
  if (supplemented) result.warnings = [...new Set([...result.warnings, 'Recently published transfers are awaiting provider synchronization.'])];
  return result;
}
