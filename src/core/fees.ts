import { feeForVsize, MAX_UNITS, parseUnits } from './amount';
import type { Utxo } from '../shared/types';

export const MAX_FEE_UNITS = 1_000_000n;
export const MAX_INPUTS = 100;

function compactSizeLength(count: number) { return count < 253 ? 1 : count <= 65535 ? 3 : 5; }

export function estimateP2wpkhVsize(inputCount: number, scripts: Uint8Array[]): number {
  const stripped = 8 + compactSizeLength(inputCount) + 41 * inputCount + compactSizeLength(scripts.length) + scripts.reduce((sum, script) => sum + 8 + compactSizeLength(script.length) + script.length, 0);
  return Math.ceil((stripped * 4 + 2 + 109 * inputCount) / 4);
}

export function dustThreshold(script: Uint8Array, rate: string): bigint {
  const result = feeForVsize(rate, 3 * (8 + compactSizeLength(script.length) + script.length + 148));
  return result > 546n ? result : 546n;
}

export function feeCaps(fee: bigint, total: bigint): void {
  if (fee <= 0n || fee > MAX_FEE_UNITS || fee * 20n > total) throw new Error('Fee exceeds absolute or 5% input-value cap');
}

/** All supported recipients have a 22-byte native P2WPKH output script. */
export function quoteNativeSendMax(inputs: readonly Pick<Utxo, 'amountUnits'>[], feeRate: string) {
  if (!inputs.length) throw new Error('No spendable native inputs');
  if (inputs.length > MAX_INPUTS) throw new Error('Send-max exceeds input-count limit');
  const total = inputs.reduce((sum, input) => sum + parseUnits(input.amountUnits, false), 0n);
  if (total > MAX_UNITS) throw new Error('Input inventory exceeds permitted amount');
  const recipientScript = new Uint8Array(22);
  const estimatedVsize = estimateP2wpkhVsize(inputs.length, [recipientScript]);
  const fee = feeForVsize(feeRate, estimatedVsize);
  const amount = total - fee;
  if (amount < dustThreshold(recipientScript, feeRate)) throw new Error('Balance is too small to cover the amount and network fee');
  feeCaps(fee, total);
  return { amountUnits: amount.toString(), feeUnits: fee.toString(), estimatedVsize };
}
