import { smokeOrigin } from './smoke-origin';
import { chromium, firefox, webkit, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

const origin = smokeOrigin();
const results: unknown[] = [];
for (const [name, browserType] of Object.entries({ chromium, firefox, webkit })) {
  const browser = await browserType.launch({ headless: true });
  const page = await browser.newPage();
  let temporarilyUnavailable = true;
  let requests = 0;
  await page.route('**/api/v1/network', async route => {
    requests++;
    if (temporarilyUnavailable) await route.fulfill({ status: 503, json: { error: { code: 'rpc-auth-unavailable', message: 'Core authentication is unavailable' } } });
    else await route.continue();
  });
  try {
    const response = await page.goto(origin);
    expect(response?.headers()['cache-control']).toBe('no-store');
    await expect(page.getByRole('alert')).toContainText('Core authentication is unavailable');
    await expect(page.getByRole('button', { name: /^Create a wallet/ })).toBeDisabled();
    temporarilyUnavailable = false;
    // No clicks, reload or synthetic online event: the retry timer must recover.
    await expect(page.getByRole('button', { name: /^Create a wallet/ })).toBeEnabled({ timeout: 40000 });
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(requests).toBeGreaterThanOrEqual(2);
    results.push({ browser: name, startupAuthenticationError: true, recoveredWithoutReloadOrClick: true, staleErrorRemoved: true, requests });
    process.stdout.write(`Public reconnect smoke passed: ${name}\n`);
  } finally { await browser.close(); }
}
await mkdir('artifacts/evidence', { recursive: true });
await writeFile('artifacts/evidence/reconnect-smoke.json', JSON.stringify({ generatedAt: new Date().toISOString(), origin,
  injectedFailureInTestBrowserOnly: true, results }, null, 2) + '\n');
