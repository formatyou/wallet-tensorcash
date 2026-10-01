import { z } from 'zod';
import { Address, OutScript } from '@scure/btc-signer';
import { hex } from '@scure/base';
import { decodeNativeTransaction } from '../core/raw';
import { networkConfig } from '../core/network';
import type { SignedTransfer, TransferPlan, WalletMetadata } from '../shared/types';

// Only public, already signed transaction data. Never seed, password, xpriv or PSBT.
// This is stored locally to retain the exact retry across lock, reload and crashes.
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const units = z.string().regex(/^(0|[1-9]\d*)$/).max(24);
const network = z.enum(['mainnet', 'regtest']);
const planSchema = z.object({
  id: z.string().min(1).max(100), network, recipient: z.string().min(1).max(100),
  amountUnits: units, feeUnits: units, feeRate: z.string().regex(/^\d+(?:\.\d{1,3})?$/).max(12),
  changeAddress: z.string().min(1).max(100).nullable(), changeUnits: units,
  inputCount: z.number().int().min(1).max(100),
  inputs: z.array(z.object({ txid: hash, vout: z.number().int().nonnegative().max(1999), amountUnits: units })).min(1).max(100),
  estimatedVsize: z.number().int().positive().max(100_000), createdAt: z.iso.datetime(),
});
const signedSchema = z.object({
  txid: hash, rawHex: z.string().regex(/^[a-f0-9]+$/).max(400_000),
  feeUnits: units, vsize: z.number().int().positive().max(100_000),
});
const schema = z.object({ version: z.literal(1), walletId: z.string().min(1).max(100), network,
  plan: planSchema, signed: signedSchema, savedAt: z.iso.datetime(), broadcastAttempted: z.boolean() });
export type BroadcastJournal = z.infer<typeof schema>;
export const journalKey = (walletId: string) => `tensorcash.broadcast.${walletId}`;

export function verifyJournal(value: unknown, metadata: Pick<WalletMetadata, 'id' | 'network'>): BroadcastJournal {
  const journal = schema.parse(value);
  const { plan, signed } = journal;
  if (journal.walletId !== metadata.id || journal.network !== metadata.network || plan.network !== metadata.network) throw new Error('Pending transfer belongs to another wallet or network.');
  const tx = decodeNativeTransaction(signed.rawHex);
  if (tx.txid !== signed.txid || tx.vsize !== signed.vsize || tx.version !== 2 || tx.lockTime !== 0 || tx.coinbase ||
      tx.inputs.length !== plan.inputCount || plan.inputs.length !== plan.inputCount || tx.outputs.length !== (plan.changeAddress ? 2 : 1)) throw new Error('Saved transaction does not match its review.');
  const script = (address: string) => hex.encode(OutScript.encode(Address(networkConfig(metadata.network).bitcoin).decode(address)));
  if (tx.outputs[0].amountUnits !== plan.amountUnits || tx.outputs[0].scriptHex !== script(plan.recipient)) throw new Error('Saved recipient differs from the signed transaction.');
  if (plan.changeAddress) {
    if (tx.outputs[1].amountUnits !== plan.changeUnits || tx.outputs[1].scriptHex !== script(plan.changeAddress)) throw new Error('Saved change differs from the signed transaction.');
  } else if (plan.changeUnits !== '0') throw new Error('Saved transfer has inconsistent change.');
  if (new Set(plan.inputs.map(input => `${input.txid}:${input.vout}`)).size !== plan.inputCount) throw new Error('Saved transfer has duplicate inputs.');
  tx.inputs.forEach((input, index) => {
    if (input.txid !== plan.inputs[index].txid || input.vout !== plan.inputs[index].vout || input.sequence !== 0xffffffff) throw new Error('Saved inputs differ from the signed transaction.');
  });
  const total = plan.inputs.reduce((amount, input) => amount + BigInt(input.amountUnits), 0n);
  const fee = total - BigInt(plan.amountUnits) - BigInt(plan.changeUnits);
  if (fee.toString() !== plan.feeUnits || signed.feeUnits !== plan.feeUnits || fee <= 0n || fee > 1_000_000n || fee * 20n > total) throw new Error('Saved transfer fee differs from its review or exceeds the safety limit.');
  return journal;
}
export function saveJournal(metadata: WalletMetadata, plan: TransferPlan, signed: SignedTransfer): void {
  const existing = loadJournal(metadata);
  if (existing && existing.signed.rawHex !== signed.rawHex) throw new Error('Resolve the previous signed transfer before preparing another payment.');
  const journal = verifyJournal({ version: 1, walletId: metadata.id, network: metadata.network, plan, signed, savedAt: new Date().toISOString(), broadcastAttempted: existing?.broadcastAttempted ?? false }, metadata);
  const stored = JSON.stringify(journal);
  localStorage.setItem(journalKey(metadata.id), stored);
  if (localStorage.getItem(journalKey(metadata.id)) !== stored) throw new Error('The signed transfer could not be saved safely. Nothing was broadcast.');
}
export function markBroadcastAttempted(metadata: WalletMetadata): void {
  const existing = loadJournal(metadata);
  if (!existing) throw new Error('The signed transfer retry copy is missing. Nothing was broadcast.');
  const stored = JSON.stringify({ ...existing, broadcastAttempted: true });
  localStorage.setItem(journalKey(metadata.id), stored);
  if (localStorage.getItem(journalKey(metadata.id)) !== stored) throw new Error('The retry status could not be saved. Nothing was broadcast.');
}
export function loadJournal(metadata: WalletMetadata): BroadcastJournal | null {
  const stored = localStorage.getItem(journalKey(metadata.id));
  if (!stored) return null;
  if (stored.length > 450_000) throw new Error('The saved transfer is invalid. Keep your wallet backup and resolve its status before sending again.');
  try { return verifyJournal(JSON.parse(stored), metadata); }
  catch { throw new Error('The saved transfer could not be verified. Keep your wallet backup and resolve its status before sending again.'); }
}
export function hasJournal(metadata: WalletMetadata): boolean { return localStorage.getItem(journalKey(metadata.id)) !== null; }
export function clearJournal(metadata: WalletMetadata): void { localStorage.removeItem(journalKey(metadata.id)); }

// An accepted transaction can reach Core before the address index catches up.
// Retain its public details across reloads until a coherent wallet view includes it.
export const acceptedTransfersKey = (walletId: string) => `tensorcash.accepted.${walletId}`;
export function loadAcceptedTransfers(metadata: WalletMetadata): BroadcastJournal[] {
  const stored = localStorage.getItem(acceptedTransfersKey(metadata.id));
  if (!stored) return [];
  try {
    if (stored.length > 2_000_000) throw new Error('Too large');
    const values: unknown = JSON.parse(stored);
    if (!Array.isArray(values) || values.length > 25) throw new Error('Invalid accepted transfers');
    const records = values.map(value => verifyJournal(value, metadata));
    if (records.some(record => !record.broadcastAttempted) || new Set(records.map(record => record.signed.txid)).size !== records.length) throw new Error('Invalid accepted transfers');
    return records;
  } catch { throw new Error('Saved published transfers could not be verified. Your last known balance is retained; sending is paused until their status can be checked.'); }
}
export function retainAcceptedTransfers(metadata: WalletMetadata, records: BroadcastJournal[]): void {
  const stored = JSON.stringify(records.map(record => verifyJournal(record, metadata)));
  if (records.length > 25 || stored.length > 2_000_000) throw new Error('Published transfer history could not be saved safely. Keep the saved transaction and check its status.');
  localStorage.setItem(acceptedTransfersKey(metadata.id), stored);
  if (localStorage.getItem(acceptedTransfersKey(metadata.id)) !== stored) throw new Error('Published transfer history could not be saved safely. Keep the saved transaction and check its status.');
}
export function rememberAcceptedTransfer(metadata: WalletMetadata, plan: TransferPlan, signed: SignedTransfer): BroadcastJournal[] {
  const previous = loadAcceptedTransfers(metadata);
  const existing = previous.find(record => record.signed.txid === signed.txid);
  if (existing && existing.signed.rawHex !== signed.rawHex) throw new Error('Published transfer data is inconsistent. Keep the saved transaction and check its status.');
  const record = verifyJournal({ version: 1, walletId: metadata.id, network: metadata.network, plan, signed,
    savedAt: new Date().toISOString(), broadcastAttempted: true }, metadata);
  const records = existing ? previous : [...previous, record];
  retainAcceptedTransfers(metadata, records);
  return records;
}
