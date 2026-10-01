import { ensure } from './errors';
export const HASH = /^[0-9a-f]{64}$/;
export const SCRIPT = /^(?:[0-9a-f]{2})+$/;
export type RecordData = Record<string, unknown>;
export function record(value: unknown): RecordData { ensure(value && typeof value === 'object' && !Array.isArray(value)); return value as RecordData; }
export function integer(value: unknown, minimum = 0): number { ensure(typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum); return value; }
export function hash(value: unknown): string { ensure(typeof value === 'string' && HASH.test(value)); return value; }
export function script(value: unknown): string { ensure(typeof value === 'string' && SCRIPT.test(value) && value.length <= 20000); return value; }
export function array(value: unknown, limit = 100000): unknown[] { ensure(Array.isArray(value) && value.length <= limit); return value; }
export function atomic(value: unknown): bigint {
  ensure((typeof value === 'string' && /^-?[0-9]+$/.test(value)) || (typeof value === 'number' && Number.isSafeInteger(value)));
  return BigInt(value as string | number);
}
// Decimal RPC amounts become bigint before any arithmetic. A raw-parent comparison
// catches any precision loss introduced by JSON numbers from Core.
export function coinUnits(value: unknown): bigint {
  ensure(typeof value === 'string' || typeof value === 'number');
  if (typeof value === 'number') ensure(Number.isFinite(value));
  const match = String(value).match(/^(-?)([0-9]+)(?:\.([0-9]+))?(?:e([+-]?[0-9]+))?$/i); ensure(match);
  const exponent = Number(match[4] || 0); ensure(Number.isSafeInteger(exponent) && Math.abs(exponent) <= 30);
  const decimal = match[3] || ''; const shift = 8 + exponent - decimal.length;
  let units = BigInt(match[2] + decimal); if (shift >= 0) units *= 10n ** BigInt(shift);
  else { const factor = 10n ** BigInt(-shift); ensure(units % factor === 0n); units /= factor; }
  return match[1] ? -units : units;
}
export function feeRate(value: unknown): bigint { const rate = coinUnits(value); ensure(rate >= 0n); return (rate + 999n) / 1000n; }
export async function mapBounded<T, R>(items: T[], fn: (item: T, index: number) => Promise<R>, concurrency = 4): Promise<R[]> {
  const result = new Array<R>(items.length); let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) { const index = cursor++; if (index >= items.length) return; result[index] = await fn(items[index], index); }
  })); return result;
}
