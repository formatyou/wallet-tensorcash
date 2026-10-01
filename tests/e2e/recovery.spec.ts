import { test, expect, type Page } from '@playwright/test';
import { Transaction } from '@scure/btc-signer';
import { hex } from '@scure/base';
import { deriveAccount, deriveAddress } from '../../src/core/keys';
import { decodeNativeTransaction } from '../../src/core/raw';
import type { NetworkReadinessReason } from '../../src/shared/types';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'wallet recovery test password';
const GENESIS = 'cf63c021e5a8ea0bc04cf7b12ab12e0a7902ef2dae5bdd8cbb3a0d41c3345da4';
async function networkFixture(page: Page) {
  const account = deriveAccount(PHRASE, 'regtest');
  const address = deriveAddress(account, 'regtest', 0, 0);
  const parent = new Transaction({ version: 2, allowUnknownInputs: true });
  parent.addInput({ txid: '11'.repeat(32), index: 0, sequence: 0xffffffff });
  parent.addOutput({ amount: 1_000_000n, script: hex.decode(address.scriptHex) });
  const rawParent = hex.encode(parent.toBytes(true, false));
  const txid = decodeNativeTransaction(rawParent).txid;
  account.wipePrivateData();
  let blocked = false;
  let blockedReason: NetworkReadinessReason = 'block-validation';
  let blockNextSync: NetworkReadinessReason | null = null;
  let unavailable = false;
  let networkRequests = 0;
  let addressRequests = 0;
  let feeRequests = 0;
  let syncFailures = 0;
  let syncBarrier: Promise<void> | null = null;
  let releaseSync: (() => void) | undefined;
  let networkBarrier: Promise<void> | null = null;
  let release: (() => void) | undefined;
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/wallet/sync') && blockNextSync) {
      blocked = true; blockedReason = blockNextSync; blockNextSync = null;
    }
    const network = { network: 'regtest', chain: 'regtest', genesisHash: GENESIS,
      height: 105, tipHash: 'aa'.repeat(32), indexedHeight: blocked && blockedReason === 'index-sync' ? 104 : 105, ready: !blocked,
      observedAt: new Date().toISOString(), explorerUrl: null, minConfirmations: 1, coinbaseMaturity: 100,
      ...(blocked ? { readinessReason: blockedReason } : {}) };
    if (path.endsWith('/network')) {
      networkRequests++;
      if (networkBarrier) await networkBarrier;
      if (unavailable) { await route.abort('failed'); return; }
      await route.fulfill({ json: network }); return;
    }
    if (path.endsWith('/wallet/sync')) {
      addressRequests++;
      if (syncBarrier) await syncBarrier;
      if (syncFailures > 0) {
        syncFailures--;
        await route.fulfill({ status: 503, json: { error: { message: 'Temporary wallet data failure' } } }); return;
      }
      const addresses: string[] = route.request().postDataJSON().addresses;
      const funded = addresses.includes(address.address);
      await route.fulfill({ json: { network,
        addresses: addresses.map(value => ({ address: value, used: value === address.address })),
        utxos: funded ? [{ txid, vout: 0, address: address.address, scriptHex: address.scriptHex,
          amountUnits: '1000000', confirmations: 5, blockHeight: 101, coinbase: false,
          classification: 'native', rawParent, verified: true }] : [],
        history: funded ? [{ txid, deltaUnits: '1000000', feeUnits: null, status: 'confirmed', confirmations: 5,
          blockHeight: 101, timestamp: 1_790_000_000 }] : [],
        complete: !blocked, warnings: [], observedAt: new Date().toISOString(), mempoolFingerprint: 'bb'.repeat(32) } }); return;
    }
    if (path.endsWith('/fees')) {
      feeRequests++;
      await route.fulfill({ json: { relayFloorUnitsPerVbyte: '1', mempoolFloorUnitsPerVbyte: '1', suggestedRate: '2', observedAt: new Date().toISOString() } }); return;
    }
    await route.fulfill({ status: 404, json: { message: 'Unexpected endpoint in read-only recovery test' } });
  });
  return {
    block: (value: boolean, reason: NetworkReadinessReason = 'block-validation') => { blocked = value; blockedReason = reason; },
    blockDuringNextSync: (reason: NetworkReadinessReason = 'index-sync') => { blockNextSync = reason; },
    unavailable: (value: boolean) => { unavailable = value; },
    networkCount: () => networkRequests, addressCount: () => addressRequests,
    feeCount: () => feeRequests,
    failNextSync: () => { syncFailures++; },
    holdSync: () => { syncBarrier = new Promise<void>(resolve => { releaseSync = resolve; }); },
    releaseSync: () => { releaseSync?.(); releaseSync = undefined; syncBarrier = null; },
    holdNetwork: () => { networkBarrier = new Promise<void>(resolve => { release = resolve; }); },
    releaseNetwork: () => { release?.(); release = undefined; networkBarrier = null; },
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
  await expect(page.getByTestId('balance-total')).toContainText('0.01');
}

for (const reason of ['block-validation', 'index-sync'] satisfies NetworkReadinessReason[]) {
  test(`${reason} onboarding shows a neutral update and recovers on the next light five-second probe`, async ({ page }) => {
    await page.clock.install();
    const fixture = await networkFixture(page); fixture.block(true, reason);
    await page.goto('/');
    const update = page.locator('.network-update');
    await expect(update).toHaveAttribute('role', 'status');
    await expect(update).toContainText('Updating wallet data');
    await expect(page.locator('.message.error')).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Retry connection', exact: true })).toHaveCount(0);
    const create = page.getByRole('button', { name: 'Create a wallet', exact: false });
    await expect(create).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Restore a wallet', exact: true })).toBeDisabled();
    const before = fixture.networkCount();
    fixture.block(false);
    await page.clock.runFor(5000);
    await expect(create).toBeEnabled();
    await expect(update).toHaveCount(0);
    expect(fixture.networkCount()).toBe(before + 1); expect(fixture.addressCount()).toBe(0);
  });
}

test('lasting index update retains balance, explains the delay neutrally, and only probes readiness until recovery', async ({ page }) => {
  await page.clock.install();
  const fixture = await networkFixture(page);
  await restore(page);
  await page.getByRole('button', { name: 'Send', exact: true }).first().click();
  const review = page.getByRole('button', { name: 'Review transfer', exact: false });
  await expect(review).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Max', exact: true })).toBeEnabled();
  const addressCount = fixture.addressCount();
  fixture.block(true, 'index-sync');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByTestId('wallet-sync')).toHaveAttribute('data-sync-state', 'stale');
  await expect(page.getByTestId('wallet-sync')).toHaveText('Updating');
  await expect(page.locator('.network-update')).toContainText('Updating wallet data');
  await expect(page.locator('.message.error')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry connection', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('send-available-balance')).toHaveText('0.01 TSC');
  await expect(review).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Max', exact: true })).toBeDisabled();
  const networkCount = fixture.networkCount();
  await page.clock.runFor(5000);
  await expect.poll(fixture.networkCount).toBeGreaterThan(networkCount);
  await page.clock.runFor(25_000);
  await expect(page.locator('.network-update')).toContainText('Wallet data is taking longer to update');
  await expect(page.getByTestId('send-available-balance')).toHaveText('0.01 TSC');
  await expect(review).toBeDisabled();
  expect(fixture.addressCount()).toBe(addressCount);
  fixture.block(false);
  await page.clock.runFor(5000);
  await expect(page.getByTestId('wallet-sync')).toHaveAttribute('data-sync-state', 'idle');
  await expect(page.locator('.network-update')).toHaveCount(0);
  await expect(review).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Max', exact: true })).toBeEnabled();
  expect(fixture.addressCount()).toBeGreaterThan(addressCount);
});

test('blocked lock and unlock recover immediately on return without concurrent readiness requests', async ({ page }) => {
  await page.clock.install();
  const fixture = await networkFixture(page);
  await restore(page);
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  fixture.block(true);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('.network-update')).toContainText('Updating wallet data');
  await expect(page.locator('.message.error')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry connection', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Unlock wallet', exact: true })).toBeEnabled();
  const addressCount = fixture.addressCount();
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Unlock wallet', exact: true }).click();
  await expect(page.getByTestId('wallet-sync')).toHaveAttribute('data-sync-state', 'stale');
  await expect(page.getByTestId('balance-total')).toContainText('0.01');
  expect(fixture.addressCount()).toBe(addressCount);
  fixture.block(false); fixture.holdNetwork();
  const networkCount = fixture.networkCount();
  await page.evaluate(() => {
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(fixture.networkCount).toBe(networkCount + 1);
  fixture.releaseNetwork();
  await expect(page.getByTestId('wallet-sync')).toHaveAttribute('data-sync-state', 'idle');
  expect(fixture.addressCount()).toBeGreaterThan(addressCount);
});

test('index update during wallet sync switches to light probes and refreshes immediately on recovery', async ({ page }) => {
  await page.clock.install();
  const fixture = await networkFixture(page);
  await restore(page);
  const addressCount = fixture.addressCount();
  fixture.blockDuringNextSync();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByTestId('wallet-sync')).toHaveAttribute('data-sync-state', 'stale');
  await expect(page.getByTestId('wallet-sync')).toHaveText('Updating');
  await expect(page.locator('.network-update')).toContainText('Updating wallet data');
  await expect(page.locator('.balance-main > .eyebrow')).toHaveText('Last known balance');
  await expect(page.getByTestId('balance-total')).toContainText('0.01');
  const send = page.locator('.balance-actions').getByRole('button', { name: 'Send', exact: true });
  await expect(send).toBeDisabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry connection', exact: true })).toHaveCount(0);
  expect(fixture.addressCount()).toBe(addressCount + 1);

  const networkCount = fixture.networkCount();
  await page.clock.runFor(5000);
  await expect.poll(fixture.networkCount).toBe(networkCount + 1);
  expect(fixture.addressCount()).toBe(addressCount + 1);
  await expect(send).toBeDisabled();

  fixture.block(false);
  await page.clock.runFor(5000);
  await expect(page.getByTestId('wallet-sync')).toHaveAttribute('data-sync-state', 'idle');
  await expect(page.locator('.network-update')).toHaveCount(0);
  await expect(page.locator('.balance-main > .eyebrow')).toHaveText('Total balance');
  await expect(send).toBeEnabled();
  expect(fixture.addressCount()).toBeGreaterThan(addressCount + 1);
});

test('verified wallet recovery survives readiness returning while a refresh is still in flight', async ({ page }) => {
  await page.clock.install();
  const fixture = await networkFixture(page);
  await restore(page);
  const addressCount = fixture.addressCount(); const feeCount = fixture.feeCount();
  fixture.holdSync(); fixture.failNextSync();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(fixture.addressCount).toBe(addressCount + 1);
  // Fee recommendations should already be fetched while the slower wallet
  // address read is pending, rather than after it completes.
  await expect.poll(fixture.feeCount).toBe(feeCount + 1);

  fixture.block(true, 'index-sync');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('.network-update')).toBeVisible();
  fixture.block(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('.network-update')).toHaveCount(0);

  // The successful readiness probe cannot start another full scan yet. Once
  // the pending request fails, recovery must retain its work and retry in 5s.
  fixture.releaseSync();
  await expect(page.getByTestId('wallet-sync')).toHaveAttribute('data-sync-state', 'stale');
  const send = page.locator('.balance-actions').getByRole('button', { name: 'Send', exact: true });
  await expect(send).toBeDisabled();
  await page.clock.runFor(5000);
  await expect(page.getByTestId('wallet-sync')).toHaveAttribute('data-sync-state', 'idle');
  await expect(send).toBeEnabled();
  expect(fixture.addressCount()).toBe(addressCount + 2);
});

test('manual retry is shown only on failure and reports the in-flight attempt and recovery', async ({ page }) => {
  await page.clock.install();
  const fixture = await networkFixture(page);
  await restore(page);
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check network connection', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry connection', exact: true })).toHaveCount(0);

  fixture.unavailable(true);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  const warning = page.locator('.message.error').filter({ hasText: 'Network connection unavailable' });
  await expect(warning).toBeVisible();
  const retry = warning.getByRole('button', { name: 'Retry connection', exact: true });
  await expect(retry).toBeEnabled();

  fixture.holdNetwork();
  const before = fixture.networkCount();
  await retry.click();
  await expect.poll(fixture.networkCount).toBe(before + 1);
  await expect(warning.getByRole('button', { name: 'Connecting…', exact: true })).toBeDisabled();
  await expect(warning.locator('.spinner')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  expect(fixture.networkCount()).toBe(before + 1);

  fixture.unavailable(false);
  fixture.releaseNetwork();
  await expect(warning).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry connection', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Your wallet, on this device.' })).toBeVisible();
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Unlock wallet', exact: true }).click();
  await expect(page.getByTestId('wallet-sync')).toHaveAttribute('data-sync-state', 'idle');
  await expect(page.getByTestId('balance-total')).toContainText('0.01');
});
