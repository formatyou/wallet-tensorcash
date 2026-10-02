import { chromium, firefox, webkit, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import type { BuildMetadata } from '../server/build';
import { smokeOrigin } from './smoke-origin';

// Landing-page verification only. Never create/unlock a wallet or send POSTs.
const origin = smokeOrigin();
async function readBuild(): Promise<BuildMetadata> {
  const response = await fetch(`${origin}/api/build`, { cache: 'no-store' });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const metadata = await response.json() as BuildMetadata;
  expect(Object.keys(metadata).sort()).toEqual(['builtAt', 'commit', 'dirty', 'release', 'schemaVersion', 'sourceSha256', 'version']);
  expect(metadata.schemaVersion).toBe(1);
  expect(metadata.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(metadata.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(metadata.release).toBe(true);
  expect(metadata.dirty).toBe(false);
  return metadata;
}
const build = await readBuild();
const results: unknown[] = [];
await mkdir('artifacts/evidence', { recursive: true });
for (const [name, browserType] of Object.entries({ chromium, firefox, webkit })) {
  const browser = await browserType.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    const blockedMethods: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', async route => {
      if (!['GET', 'HEAD'].includes(route.request().method())) {
        blockedMethods.push(route.request().method());
        return route.abort('blockedbyclient');
      }
      return route.continue();
    });
    const response = await page.goto(origin);
    expect(response?.status()).toBe(200);
    expect(response?.headers()['cache-control']).toBe('no-store');
    expect(response?.headers()['content-security-policy']).toContain("script-src 'self'");
    expect(response?.headers()['strict-transport-security']).toContain('max-age=31536000');
    expect(await page.evaluate(() => isSecureContext && !!crypto.subtle)).toBe(true);
    await expect(page.getByRole('heading', { name: 'A simple home for your TensorCash.', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Create a wallet/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Review the source/ })).toHaveAttribute('href', 'https://github.com/formatyou/wallet-tensorcash');
    const widths: number[] = [];
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      widths.push(width);
    }
    expect(blockedMethods).toHaveLength(0);
    expect(errors).toHaveLength(0);
    results.push({ browser: name, secureContext: true, noRuntimeErrors: true, landingUi: true, widths, getOnly: true });
    process.stdout.write(`Read-only HTTPS smoke passed: ${name}\n`);
  } finally { await browser.close(); }
}
expect(await readBuild()).toEqual(build);
await writeFile('artifacts/evidence/production-smoke.json', JSON.stringify({
  generatedAt: new Date().toISOString(), origin, build, results,
  getOnly: true, walletsCreated: false, mainnetFundsSent: false,
}, null, 2) + '\n');
