import { hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { MAX_UNITS } from './amount';

export interface NativeTransaction {
  txid: string; wtxid: string; version: number; lockTime: number; coinbase: boolean;
  inputs: { txid: string; vout: number; scriptHex: string; sequence: number }[];
  outputs: { amountUnits: string; scriptHex: string; vout: number }[];
  vsize: number; weight: number;
}
export function decodeNativeTransaction(rawHex: string): NativeTransaction {
  if (typeof rawHex !== 'string' || rawHex.length < 20 || rawHex.length > 2_000_000 || rawHex.length % 2 || !/^[0-9a-fA-F]+$/.test(rawHex)) throw new Error('Invalid raw transaction hex');
  const bytes = hex.decode(rawHex); const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let pos = 0;
  const take = (size: number) => { if (!Number.isSafeInteger(size) || size < 0 || pos + size > bytes.length) throw new Error('Truncated transaction'); const b = bytes.subarray(pos, pos + size); pos += size; return b; };
  const u8 = () => take(1)[0];
  const u32 = () => { take(4); return view.getUint32(pos - 4, true); };
  const compact = (cap: number) => { const first = u8(); let result: bigint;
    if (first < 253) result = BigInt(first);
    else if (first === 253) { take(2); result = BigInt(view.getUint16(pos - 2, true)); if (result < 253n) throw new Error('Noncanonical CompactSize'); }
    else if (first === 254) { result = BigInt(u32()); if (result <= 65535n) throw new Error('Noncanonical CompactSize'); }
    else { take(8); result = view.getBigUint64(pos - 8, true); if (result <= 0xffffffffn) throw new Error('Noncanonical CompactSize'); }
    if (result > BigInt(cap)) throw new Error('Transaction field exceeds limit'); return Number(result);
  };
  const version = u32(); if (version !== 1 && version !== 2) throw new Error('Unsupported transaction version');
  let witness = false;
  if (bytes[pos] === 0) { u8(); const flags = u8(); if (flags !== 1) throw new Error('Unsupported transaction extensions or flags'); witness = true; }
  const bodyStart = pos; const inputCount = compact(1000); if (!inputCount) throw new Error('Transaction has no inputs');
  const inputs = Array.from({ length: inputCount }, () => { const txid = hex.encode(Uint8Array.from(take(32)).reverse()); const vout = u32(); const scriptHex = hex.encode(take(compact(10_000))); const sequence = u32(); return { txid, vout, scriptHex, sequence }; });
  const outputCount = compact(2000); if (!outputCount) throw new Error('Transaction has no outputs');
  let total = 0n;
  const outputs = Array.from({ length: outputCount }, (_, vout) => { take(8); const amount = view.getBigUint64(pos - 8, true); total += amount; if (amount > MAX_UNITS || total > MAX_UNITS) throw new Error('Invalid transaction output amount'); const scriptHex = hex.encode(take(compact(10_000))); return { amountUnits: String(amount), scriptHex, vout }; });
  const bodyEnd = pos;
  if (witness) { let nonempty = false; for (let i = 0; i < inputCount; i++) { const count = compact(1000); nonempty ||= count > 0; for (let j = 0; j < count; j++) take(compact(100_000)); } if (!nonempty) throw new Error('Superfluous witness record'); }
  const lockStart = pos; const lockTime = u32(); if (pos !== bytes.length) throw new Error('Trailing transaction data');
  const stripped = new Uint8Array(4 + bodyEnd - bodyStart + 4); stripped.set(bytes.subarray(0, 4)); stripped.set(bytes.subarray(bodyStart, bodyEnd), 4); stripped.set(bytes.subarray(lockStart), stripped.length - 4);
  const hash = (b: Uint8Array) => hex.encode(sha256(sha256(b)).reverse());
  const coinbase = inputs.length === 1 && inputs[0].txid === '0'.repeat(64) && inputs[0].vout === 0xffffffff;
  if (!coinbase && inputs.some(i => i.txid === '0'.repeat(64))) throw new Error('Invalid null transaction input');
  const weight = stripped.length * 3 + bytes.length;
  return { txid: hash(stripped), wtxid: hash(bytes), version, lockTime, coinbase, inputs, outputs, weight, vsize: Math.ceil(weight / 4) };
}
