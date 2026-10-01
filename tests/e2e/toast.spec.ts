import { test, expect, type Page } from '@playwright/test';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'wallet toast test password';

async function mockWallet(page: Page) {
  let unavailable = false;
  let barrier: Promise<void> | null = null;
  let release: (() => void) | null = null;
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const network = { network: 'regtest', chain: 'regtest',
      genesisHash: 'cf63c021e5a8ea0bc04cf7b12ab12e0a7902ef2dae5bdd8cbb3a0d41c3345da4',
      height: 105, tipHash: 'aa'.repeat(32), indexedHeight: 105, ready: true,
      observedAt: new Date().toISOString(), explorerUrl: null, minConfirmations: 1, coinbaseMaturity: 100 };
    if (path.endsWith('/network')) {
      if (barrier) await barrier;
      if (unavailable) { await route.abort('failed'); return; }
      await route.fulfill({ json: network }); return;
    }
    if (path.endsWith('/fees')) {
      await route.fulfill({ json: { relayFloorUnitsPerVbyte: '1', mempoolFloorUnitsPerVbyte: '1', suggestedRate: '2', observedAt: new Date().toISOString() } }); return;
    }
    if (path.endsWith('/wallet/sync')) {
      const addresses: string[] = route.request().postDataJSON().addresses;
      await route.fulfill({ json: { network, addresses: addresses.map(address => ({ address, used: false })),
        utxos: [], history: [], complete: true, warnings: [], observedAt: new Date().toISOString(), mempoolFingerprint: 'bb'.repeat(32) } }); return;
    }
    await route.fulfill({ status: 404, json: { message: 'Unexpected endpoint in notification test' } });
  });
  return {
    unavailable: (value: boolean) => { unavailable = value; },
    holdNetwork: () => { barrier = new Promise<void>(resolve => { release = resolve; }); },
    releaseNetwork: () => { release?.(); release = null; barrier = null; },
  };
}

async function restore(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Restore a wallet', exact: true }).click();
  await page.locator('textarea[name="mnemonic"]').fill(PHRASE);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('input[name="confirmPassword"]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Restore wallet', exact: true }).click();
  await expect(page.getByTestId('wallet-sync')).toHaveAttribute('data-sync-state', 'idle');
}

test('lock notification is compact with a centered dismiss control on desktop and mobile', async ({ page }, testInfo) => {
  await mockWallet(page);
  await restore(page);
  await page.clock.install();
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  const toast = page.getByTestId('wallet-toast');
  await expect(toast.getByRole('status')).toHaveText('Wallet locked.');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await toast.evaluate(node => {
      const rect = node.getBoundingClientRect();
      const close = node.querySelector('.toast-dismiss')!.getBoundingClientRect();
      const glyph = node.querySelector('.toast-dismiss svg')!.getBoundingClientRect();
      return { width: rect.width, left: rect.left, right: rect.right,
        buttonHeight: close.height, buttonWidth: close.width,
        centerOffset: Math.abs((rect.top + rect.bottom) / 2 - (close.top + close.bottom) / 2),
        glyphOffset: Math.abs((close.top + close.bottom) / 2 - (glyph.top + glyph.bottom) / 2),
        overflow: document.documentElement.scrollWidth > innerWidth };
    });
    expect(layout.width).toBeLessThan(260);
    expect(layout.left).toBeGreaterThanOrEqual(16);
    expect(layout.right).toBeLessThanOrEqual(width - 16);
    expect(layout.buttonHeight).toBe(44);
    expect(layout.buttonWidth).toBe(44);
    expect(layout.centerOffset).toBeLessThan(1);
    expect(layout.glyphOffset).toBeLessThan(1);
    expect(layout.overflow).toBe(false);
    await page.screenshot({ path: `artifacts/toast-lock-${testInfo.project.name}-${width}.png`, fullPage: true });
  }
  const dismiss = toast.getByRole('button', { name: 'Dismiss notice', exact: true });
  await dismiss.focus();
  await page.clock.runFor(8_000);
  await expect(toast).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(toast).toHaveCount(0);
});

test('success feedback expires without creating notifications for background synchronization', async ({ page }) => {
  await mockWallet(page);
  await restore(page);
  await page.clock.install();
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  await expect(page.getByTestId('wallet-toast')).toBeVisible();
  await page.mouse.move(0, 0);
  await page.clock.runFor(6_100);
  await expect(page.getByTestId('wallet-toast')).toHaveCount(0);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Unlock wallet', exact: true }).click();
  await expect(page.getByTestId('wallet-sync')).toHaveAttribute('data-sync-state', 'idle');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByTestId('wallet-sync')).toHaveAttribute('data-sync-state', 'idle');
  await expect(page.getByTestId('wallet-toast')).toHaveCount(0);
});

test('a persistent connection error keeps retry feedback visible and dismiss centered when text wraps', async ({ page }, testInfo) => {
  const fixture = await mockWallet(page);
  await restore(page);
  await page.clock.install();
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  await page.getByRole('button', { name: 'Dismiss notice', exact: true }).click();
  fixture.unavailable(true);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  const toast = page.getByTestId('wallet-toast');
  await expect(toast.getByRole('alert')).toContainText('Network connection unavailable');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await toast.evaluate(node => {
      const rect = node.getBoundingClientRect();
      const close = node.querySelector('.toast-dismiss')!.getBoundingClientRect();
      const action = node.querySelector('.connection-retry')!.getBoundingClientRect();
      return { left: rect.left, right: rect.right, actionRight: action.right, closeLeft: close.left,
        centerOffset: Math.abs((rect.top + rect.bottom) / 2 - (close.top + close.bottom) / 2),
        overflow: document.documentElement.scrollWidth > innerWidth };
    });
    expect(layout.left).toBeGreaterThanOrEqual(16);
    expect(layout.right).toBeLessThanOrEqual(width - 16);
    expect(layout.actionRight).toBeLessThanOrEqual(layout.closeLeft);
    expect(layout.centerOffset).toBeLessThan(1);
    expect(layout.overflow).toBe(false);
    await page.screenshot({ path: `artifacts/toast-error-${testInfo.project.name}-${width}.png`, fullPage: true });
  }
  await page.clock.runFor(8_000);
  await expect(toast).toBeVisible();
  fixture.holdNetwork();
  await toast.getByRole('button', { name: 'Retry connection', exact: true }).click();
  await expect(toast.getByRole('button', { name: 'Connecting…', exact: true })).toBeDisabled();
  fixture.unavailable(false); fixture.releaseNetwork();
  await expect(toast).toHaveCount(0);
});
