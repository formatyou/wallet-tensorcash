import { smokeOrigin } from './smoke-origin';
import { chromium, firefox, webkit, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

const origin = smokeOrigin();
const selectedBrowser = process.env.USABILITY_BROWSER;
if (selectedBrowser && !['chromium', 'firefox', 'webkit'].includes(selectedBrowser)) throw new Error('Unknown usability browser');
const results: unknown[] = [];
await mkdir('artifacts/evidence', { recursive: true });
await mkdir('artifacts/usability', { recursive: true });

for (const [name, browserType] of Object.entries({ chromium, firefox, webkit })) {
  if (selectedBrowser && selectedBrowser !== name) continue;
  const browser = await browserType.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: name === 'webkit' ? 390 : 1440, height: name === 'webkit' ? 844 : 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  const requests: string[] = [];
  const errors: string[] = [];
  let blocked = false;
  let unavailable = false;
  let syncCallsWhileBlocked = 0;
  let publications = 0;
  let manualProbeBarrier: Promise<void> | null = null;
  let releaseManualProbe: (() => void) | undefined;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (request.postData()) requests.push(request.postData()!);
    if (blocked && path === '/api/v1/wallet/sync') syncCallsWhileBlocked++;
    if (path === '/api/v1/tx/validate' || path === '/api/v1/tx/broadcast') publications++;
  });
  await page.route('**/api/v1/network', async route => {
    if (manualProbeBarrier) await manualProbeBarrier;
    if (unavailable) return route.abort('failed');
    if (!blocked) return route.continue();
    const response = await route.fetch();
    const network = await response.json();
    await route.fulfill({ response, json: { ...network, ready: false, indexedHeight: Math.max(0, network.height - 1), readinessReason: 'index-sync' } });
  });
  const password = `ephemeral-usability-${crypto.randomUUID()}`;
  try {
    const response = await page.goto(origin);
    expect(response?.headers()['cache-control']).toBe('no-store');
    await page.getByRole('button', { name: /^Create a wallet/ }).click({ timeout: 180000 });
    await page.locator('input[name=password]').fill(password);
    await page.locator('input[name=confirmPassword]').fill(password);
    await page.getByRole('button', { name: 'Create & back up wallet' }).click();
    await expect(page.locator('.seed-grid li')).toHaveCount(12);
    const words = await page.locator('.seed-grid li').evaluateAll(nodes => nodes.map(node => node.lastChild?.textContent ?? ''));
    await page.getByRole('button', { name: 'I have written down all 12 words' }).click();
    for (const index of [2, 5, 9]) await page.locator(`input[name=word${index}]`).fill(words[index]);
    await page.getByRole('button', { name: 'Confirm backup & open wallet' }).click();
    await expect(page.getByTestId('wallet-sync')).toHaveAttribute('data-sync-state', 'idle', { timeout: 180000 });
    await expect(page.getByTestId('balance-total')).toHaveText('0TSC');
    const details = page.locator('details.network-details');
    await expect(details).toHaveCount(1);
    expect(await details.evaluate(element => (element as HTMLDetailsElement).open)).toBe(false);
    await expect(page.getByTestId('block-timing')).not.toBeVisible();
    await expect(page.getByTestId('balance-unsupported')).toHaveCount(0);
    await expect.poll(async () => page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('tensorcash-wallet-v1');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        return await new Promise<number>((resolve, reject) => {
          const request = db.transaction('vault', 'readonly').objectStore('vault').getAllKeys();
          request.onsuccess = () => resolve(request.result.filter(key => key !== 'active').length);
          request.onerror = () => reject(request.error);
        });
      } finally { db.close(); }
    })).toBeGreaterThan(0);

    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `artifacts/usability/${name}-overview-${width}.png`, fullPage: true });
    }
    await details.locator('summary').click();
    await expect(page.getByTestId('block-timing')).toBeVisible();
    await details.locator('summary').click();

    await page.getByRole('navigation', { name: 'Wallet sections' }).getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.locator('.settings-info')).toContainText('Auto-lock');
    await expect(page.locator('.settings-info')).toContainText('5 minutes without activity');
    await page.getByRole('button', { name: 'Lock', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Check network connection', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Retry connection', exact: true })).toHaveCount(0);
    await expect(page.getByText('Automatically locks after five minutes', { exact: false })).toHaveCount(0);

    blocked = true;
    await page.reload();
    await expect(page.locator('.network-update')).toHaveAttribute('role', 'status');
    await expect(page.locator('.network-update')).toContainText('Updating wallet data');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Retry connection', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Unlock wallet', exact: true })).toBeEnabled();

    blocked = false; unavailable = true;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    const warning = page.locator('.message.error').filter({ hasText: 'Network connection unavailable' });
    await expect(warning).toBeVisible();
    await expect(page.locator('.network-update')).toHaveCount(0);
    const retry = warning.getByRole('button', { name: 'Retry connection', exact: true });
    await expect(retry).toBeEnabled();
    unavailable = false;
    manualProbeBarrier = new Promise<void>(resolve => { releaseManualProbe = resolve; });
    await retry.click();
    await expect(warning.getByRole('button', { name: 'Connecting…', exact: true })).toBeDisabled();
    await expect(warning.locator('.spinner')).toBeVisible();
    releaseManualProbe!();
    manualProbeBarrier = null;
    await expect(warning).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Retry connection', exact: true })).toHaveCount(0);
    await page.screenshot({ path: `artifacts/usability/${name}-unlock-320.png`, fullPage: true });

    blocked = true;
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Your wallet, on this device.' })).toBeVisible();
    await page.locator('input[name=password]').fill(password);
    await page.getByRole('button', { name: 'Unlock wallet', exact: true }).click();
    await expect(page.getByTestId('balance-total')).toHaveText('0TSC');
    await expect(page.locator('.balance-main .eyebrow')).toHaveText('Last known balance');
    await expect(page.locator('.balance-main .balance-meta')).toContainText('Last verified');
    await expect(page.locator('.network-update')).toHaveAttribute('role', 'status');
    await expect(page.locator('.network-update')).toContainText('Updating wallet data');
    await expect(page.getByTestId('wallet-sync')).toHaveText('Updating');
    await expect(page.locator('.sync-warning')).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Retry connection', exact: true })).toHaveCount(0);
    await expect(page.locator('.balance-actions').getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await page.screenshot({ path: `artifacts/usability/${name}-last-known-320.png`, fullPage: true });
    await page.getByRole('navigation', { name: 'Wallet sections' }).getByRole('button', { name: 'Receive', exact: true }).click();
    await expect(page.locator('.address-box')).toContainText('tc1q');
    await expect(page.getByRole('img', { name: 'QR code for your TensorCash receive address' })).toBeVisible();
    expect(syncCallsWhileBlocked).toBe(0);

    const recoveryStarted = performance.now();
    blocked = false;
    await expect(page.getByTestId('wallet-sync')).toHaveAttribute('data-sync-state', 'idle', { timeout: 180000 });
    const recoveryMs = Math.round(performance.now() - recoveryStarted);
    await expect(page.locator('.network-update')).toHaveCount(0);
    await expect(page.locator('.sync-warning')).toHaveCount(0);
    await page.getByRole('navigation', { name: 'Wallet sections' }).getByRole('button', { name: 'Overview', exact: true }).click();
    await expect(page.locator('.balance-main .balance-meta')).toContainText('Updated');
    expect(publications).toBe(0);
    expect(requests.some(body => body.includes(password) || body.includes(words.join(' ')))).toBe(false);
    expect(errors).toHaveLength(0);
    results.push({ browser: name, cacheRestoredAfterReloadWhileBlocked: true, balanceStayedKnown: true,
      cacheDisplayDoesNotAllowSend: true, cachedReceiveQrAvailable: true, networkDetailsCollapsed: true,
      duplicateWarningsAbsent: true, noFullSyncWhileBlocked: true, recoveryMs,
      idleLockCopyOnlyInSettings: true, redundantNetworkCheckAbsent: true,
      neutralReadinessStatus: true, readinessRetryConnectionAbsent: true,
      manualRetryOnlyOnFailure: true, manualRetryProgressVisible: true, manualRetryClearsWarningOnRecovery: true,
      viewportWidths: [1440, 390, 320], noOverflow: true, noMainnetTransactions: true,
      noSecretInRequests: true, noRuntimeErrors: true });
    process.stdout.write(`Public usability smoke passed: ${name} (recovery ${recoveryMs} ms)\n`);
  } finally { await context.close(); await browser.close(); }
}
await writeFile(`artifacts/evidence/usability-smoke${selectedBrowser ? `-${selectedBrowser}` : ''}.json`, JSON.stringify({ generatedAt: new Date().toISOString(), origin,
  failureInjectedOnlyInEphemeralTestBrowser: true, mainnetFundsSent: false, results }, null, 2) + '\n');
