import { smokeOrigin } from './smoke-origin';
import { chromium, firefox, webkit, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import type { NetworkInfo } from '../src/shared/types';

const origin = smokeOrigin();
const version = JSON.parse(await readFile('package.json', 'utf8')).version as string;
const assets: { file: string; sha256: string }[] = [];
for (const file of await readdir('dist/assets')) {
  if (!/\.(js|css)$/.test(file)) continue;
  const built = await readFile(`dist/assets/${file}`);
  const response = await fetch(`${origin}/assets/${file}`);
  expect(response.status).toBe(200);
  const publicBytes = Buffer.from(await response.arrayBuffer());
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  expect(hash(publicBytes)).toBe(hash(built));
  assets.push({ file, sha256: hash(built) });
}

const results: unknown[] = [];
for (const [name, browserType] of Object.entries({ chromium, firefox, webkit })) {
  const browser = await browserType.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const networkResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/network');
    const response = await page.goto(origin);
    expect(response?.status()).toBe(200);
    expect(response?.headers()['content-security-policy']).toContain("script-src 'self'");
    expect(response?.headers()['strict-transport-security']).toContain('max-age=31536000');
    const network = await (await networkResponse).json() as NetworkInfo;
    expect(network.network).toBe('mainnet');
    expect(network.genesisHash).toBe('8fe43be4634dc48def074fa840e25a71bbdc32576eb29abf3ce2458605343720');
    expect(network.minConfirmations).toBe(2);
    await expect(page.getByRole('button', { name: /^Create a wallet/ })).toBeVisible();
    if (!network.ready && ['block-validation', 'index-sync'].includes(network.readinessReason ?? '')) {
      await expect(page.locator('.network-update')).toHaveAttribute('role', 'status');
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(page.getByRole('button', { name: /^Create a wallet/ })).toBeDisabled();
    }
    const layoutChecks: { width: number; overflow: boolean }[] = [];
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      expect(overflow).toBe(false);
      layoutChecks.push({ width, overflow });
    }
    expect(await page.evaluate(() => isSecureContext && !!crypto.subtle)).toBe(true);
    expect(errors).toHaveLength(0);
    results.push({ browser: name, realPublicAssets: true, secureContext: true, noRuntimeErrors: true,
      layoutChecks, networkReady: network.ready, readinessReason: network.readinessReason });
    process.stdout.write(`UTXO deployment check passed: ${name}\n`);
  } finally { await browser.close(); }
}
await mkdir('artifacts/evidence', { recursive: true });
await writeFile('artifacts/evidence/utxos-deployment.json', JSON.stringify({ generatedAt: new Date().toISOString(),
  status: 'passed', origin, version, assets, results,
  mainnetFundsSent: false, walletDiscoveryTestedHere: false,
  transactionEvidence: 'utxos-regtest-{chromium,firefox,webkit}.json' }, null, 2) + '\n');
