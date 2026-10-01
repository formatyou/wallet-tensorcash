// Readiness checks only: never use this short delay for address discovery.
export function networkRetryDelay(ready: boolean, unavailableAttempts: number): number {
  if (ready) return 30_000;
  if (unavailableAttempts <= 1) return 5_000;
  return Math.min(5_000 * 2 ** Math.min(unavailableAttempts - 1, 3), 30_000);
}

// Keep recovery pending until a complete wallet view and fee policy are read.
// A successful /network response alone must not consume that work.
export class WalletRecovery {
  needed = false;
  private failures = 0;
  private retryAt = 0;
  require(): void { this.needed = true; }
  failed(now = Date.now()): void {
    this.needed = true;
    this.retryAt = now + networkRetryDelay(false, ++this.failures);
  }
  succeeded(): void { this.needed = false; this.failures = 0; this.retryAt = 0; }
  due(now = Date.now()): boolean { return this.needed && now >= this.retryAt; }
  delay(networkReady: boolean, unavailableAttempts: number, now = Date.now()): number {
    if (!networkReady || !this.needed) return networkRetryDelay(networkReady, unavailableAttempts);
    return Math.max(1_000, Math.min(30_000, this.retryAt - now));
  }
}
