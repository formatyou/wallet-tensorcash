export const COIN = 100_000_000n;
export const MAX_UNITS = 2_100_000_000_000_000n;
export function parseUnits(value: string, allowZero = true): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(value)) throw new Error('Amount must be canonical integer base units');
  const result = BigInt(value);
  if (result > MAX_UNITS || (!allowZero && result === 0n)) throw new Error('Amount is outside the permitted range');
  return result;
}
export function parseRate(value: string): { numerator: bigint; denominator: bigint } {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,3})(\.[0-9]{1,3})?$/.test(value)) throw new Error('Invalid fee rate');
  const [whole, fractional = ''] = value.split('.');
  const denominator = 10n ** BigInt(fractional.length);
  const numerator = BigInt(whole) * denominator + BigInt(fractional || '0');
  if (numerator < denominator || numerator > 1000n * denominator) throw new Error('Fee rate must be between 1 and 1000 base units/vbyte');
  return { numerator, denominator };
}
export function feeForVsize(rate: string, size: number): bigint {
  if (!Number.isSafeInteger(size) || size < 1 || size > 100_000) throw new Error('Invalid transaction size');
  const { numerator, denominator } = parseRate(rate);
  return (numerator * BigInt(size) + denominator - 1n) / denominator;
}
