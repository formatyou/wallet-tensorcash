/** Smoke checks must opt into a specific operator-controlled HTTPS origin. */
export function smokeOrigin(): string {
  const value = process.env.WALLET_SMOKE_ORIGIN;
  if (!value) throw new Error('Set WALLET_SMOKE_ORIGIN to the HTTPS origin to check.');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password)
    throw new Error('WALLET_SMOKE_ORIGIN must be an exact HTTPS origin without credentials.');
  return url.origin;
}
