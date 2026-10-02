import { test, expect, type Page } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { Transaction } from '@scure/btc-signer';
import { hex } from '@scure/base';
import { deriveAccount, deriveAddress } from '../../src/core/keys';
import { decodeNativeTransaction } from '../../src/core/raw';
import type { Utxo } from '../../src/shared/types';
import { formatTsc } from '../../src/ui/format';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'wallet test password 2026';
const GENESIS = 'cf63c021e5a8ea0bc04cf7b12ab12e0a7902ef2dae5bdd8cbb3a0d41c3345da4';
function fundingFixture(network: 'mainnet' | 'regtest' = 'regtest') {
  const account = deriveAccount(PHRASE, network);
  const address = deriveAddress(account, network, 0, 0);
  const recipient = deriveAddress(account, network, 0, 50).address;
  const parent = new Transaction({ version: 2, allowUnknownInputs: true });
  parent.addInput({ txid: '11'.repeat(32), index: 0, sequence: 0xffffffff });
  parent.addOutput({ amount: 1_000_000n, script: hex.decode(address.scriptHex) });
  const rawParent = hex.encode(parent.toBytes(true, false));
  const txid = decodeNativeTransaction(rawParent).txid;
  const utxo: Utxo = { txid, vout: 0, address: address.address, scriptHex: address.scriptHex,
    amountUnits: '1000000', confirmations: 5, blockHeight: 100, coinbase: false, classification: 'native', rawParent, verified: true };
  account.wipePrivateData();
  return { utxo, recipient };
}
async function mockRegtest(page: Page, funded = false, timeoutFirstBroadcast = false, networkName: 'mainnet' | 'regtest' = 'regtest') {
  const fixture = fundingFixture(networkName);
  const requests: string[] = [];
  const broadcasts: string[] = [];
  let rejection: boolean | null = null;
  let networkIssue: 'authentication' | 'synchronizing' | null = null;
  let syncIssue: 'incomplete' | 'failure' | null = null;
  let feesUnavailable = false;
  let fundingConfirmations = fixture.utxo.confirmations;
  let requiredConfirmations = 1;
  let timing: { averageBlockSeconds?: number; blockTimeSampleSize?: number; lastBlockTime?: number } = {};
  let explorerUrl: string | null = null;
  let syncBarrier: Promise<void> | null = null;
  let releaseSync: (() => void) | null = null;
  await page.route('**/api/v1/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    requests.push(request.postData() ?? '');
    const network = { network: networkName, chain: networkName === 'mainnet' ? 'tensor' : 'regtest',
      genesisHash: networkName === 'mainnet' ? '8fe43be4634dc48def074fa840e25a71bbdc32576eb29abf3ce2458605343720' : GENESIS, height: 105,
      tipHash: 'aa'.repeat(32), indexedHeight: 105, ready: true, observedAt: new Date().toISOString(),
      explorerUrl, minConfirmations: requiredConfirmations, coinbaseMaturity: 100, ...timing };
    let result: unknown;
    if (path.endsWith('/network')) {
      if (networkIssue === 'authentication') {
        await route.fulfill({ status: 503, json: { message: 'Core authentication is unavailable',
          error: { code: 'core-authentication-unavailable', message: 'Core authentication is unavailable' } } });
        return;
      }
      result = networkIssue === 'synchronizing' ? { ...network, ready: false, indexedHeight: 100 } : network;
    }
    else if (path.endsWith('/fees')) {
      if (feesUnavailable) { await route.fulfill({ status: 503, json: { message: 'Fee recommendations unavailable' } }); return; }
      result = { relayFloorUnitsPerVbyte: '1', mempoolFloorUnitsPerVbyte: '1', suggestedRate: '2', observedAt: new Date().toISOString() };
    }
    else if (path.endsWith('/wallet/sync')) {
      if (syncBarrier) await syncBarrier;
      if (syncIssue === 'failure') { await route.fulfill({ status: 503, json: { message: 'Temporary synchronization failure' } }); return; }
      const addresses = (request.postDataJSON() as { addresses: string[] }).addresses;
      const hasFunding = funded && addresses.includes(fixture.utxo.address);
      const blockHeight = fundingConfirmations > 0 ? 105 - fundingConfirmations + 1 : null;
      result = { network, addresses: addresses.map(address => ({ address, used: funded && address === fixture.utxo.address })),
        utxos: hasFunding ? [{ ...fixture.utxo, confirmations: fundingConfirmations, blockHeight }] : [], history: hasFunding ? [{ txid: fixture.utxo.txid, deltaUnits: '1000000', feeUnits: null,
          status: fundingConfirmations > 0 ? 'confirmed' : 'pending', confirmations: fundingConfirmations, blockHeight, timestamp: 1_790_000_000 }] : [],
        complete: syncIssue !== 'incomplete', warnings: syncIssue === 'incomplete' ? ['Address history is incomplete.'] : [], observedAt: new Date().toISOString(), mempoolFingerprint: 'bb'.repeat(32) };
    } else if (path.endsWith('/tx/validate')) {
      const rawHex = (request.postDataJSON() as { rawHex: string }).rawHex;
      result = { txid: decodeNativeTransaction(rawHex).txid, allowed: rejection === null,
        ...(rejection === null ? {} : { canDiscard: rejection, reason: 'Rejected by the controlled test node.' }) };
    } else if (path.endsWith('/tx/broadcast')) {
      const rawHex = (request.postDataJSON() as { rawHex: string }).rawHex;
      broadcasts.push(rawHex);
      if (timeoutFirstBroadcast && broadcasts.length === 1) { await route.abort('failed'); return; }
      result = { txid: decodeNativeTransaction(rawHex).txid, status: 'accepted' };
    } else { await route.fulfill({ status: 404, json: { message: 'Unmocked endpoint' } }); return; }
    await route.fulfill({ json: result });
  });
  return { requests, broadcasts, fixture, setRejection: (canDiscard: boolean | null) => { rejection = canDiscard; },
    setNetworkIssue: (issue: typeof networkIssue) => { networkIssue = issue; },
    setSyncIssue: (issue: typeof syncIssue) => { syncIssue = issue; },
    setFeesUnavailable: (value: boolean) => { feesUnavailable = value; },
    setConfirmations: (value: number, required = 3) => { fundingConfirmations = value; requiredConfirmations = required; },
    setTiming: (value: typeof timing) => { timing = value; },
    setExplorer: (value: string | null) => { explorerUrl = value; },
    holdSync: () => { syncBarrier = new Promise<void>(resolve => { releaseSync = resolve; }); },
    releaseSync: () => { releaseSync?.(); releaseSync = null; syncBarrier = null; } };
}
async function restorePhrase(page: Page, waitForSync = true) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Restore a wallet', exact: true }).click();
  await page.locator('textarea[name="mnemonic"]').fill(PHRASE);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('input[name="confirmPassword"]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Restore wallet', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Keep it simple.' })).toBeVisible();
  if (waitForSync) await expect(page.getByTestId('wallet-sync')).toHaveAttribute('data-sync-state', 'idle');
}
async function unlock(page: Page) {
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Unlock wallet', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Keep it simple.' })).toBeVisible();
}
test('real Worker: restore errors stay visible, preserve input and never save an invalid phrase', async ({ page }) => {
  await mockRegtest(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Restore a wallet', exact: true }).click();
  const phrase = page.locator('textarea[name="mnemonic"]');
  const submit = page.getByRole('button', { name: 'Restore wallet', exact: true });
  const error = page.locator('#restore-error');
  const savedVault = () => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('tensorcash-wallet-v1', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const request = db.transaction('vault', 'readonly').objectStore('vault').get('active');
        request.onsuccess = () => resolve(request.result !== undefined);
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  });
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('input[name="confirmPassword"]').fill(PASSWORD);
  for (const [input, message] of [
    [PHRASE.replace('abandon', 'abandno'), 'Recovery word 1 is not in the English word list.'],
    [PHRASE.split(' ').slice(1).join(' '), 'Enter exactly 12 recovery words. You entered 11.'],
    ['abandon '.repeat(11) + 'abandon', 'The recovery phrase checksum is invalid.'],
    ['abandon '.repeat(150), 'The recovery phrase is too long.'],
  ]) {
    await phrase.fill(input!);
    await submit.click();
    await expect(error).toContainText(message!);
    await expect(error).toBeVisible();
    await expect(error).toBeFocused();
    await expect(phrase).toHaveValue(input!);
    await expect(submit).toBeEnabled();
    expect(await savedVault()).toBe(false);
  }
  await phrase.fill(PHRASE);
  await page.locator('input[name="confirmPassword"]').fill('');
  await submit.click();
  await expect(error).toBeVisible();
  await expect(phrase).toHaveValue(PHRASE);
  expect(await savedVault()).toBe(false);
  await page.locator('input[name="confirmPassword"]').fill(PASSWORD);
  await submit.click();
  await expect(page.getByRole('heading', { name: 'Keep it simple.' })).toBeVisible();
  expect(await savedVault()).toBe(true);
});

test('real Worker: mandatory mnemonic backup, receive, encrypted export and clean-profile restore', async ({ page, browser }) => {
  const { requests } = await mockRegtest(page);
  await page.goto('/');
  await page.getByRole('button', { name: /^Create a wallet/ }).click();
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('input[name="confirmPassword"]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create & back up wallet' }).click();
  await expect(page.getByRole('heading', { name: 'Write down these 12 words' })).toBeVisible();
  const words = await page.locator('.seed-grid li').evaluateAll(nodes => nodes.map(node => node.lastChild?.textContent ?? ''));
  expect(words).toHaveLength(12);
  await page.getByRole('button', { name: 'I have written down all 12 words' }).click();
  for (const index of [2, 5, 9]) await page.locator(`input[name="word${index}"]`).fill('wrong');
  await page.getByRole('button', { name: 'Confirm backup & open wallet' }).click();
  await expect(page.getByRole('alert')).toContainText('Those words do not match');
  await expect(page.getByRole('heading', { name: 'Check your written backup' })).toBeVisible();
  for (const index of [2, 5, 9]) await page.locator(`input[name="word${index}"]`).fill(words[index]);
  await page.getByRole('button', { name: 'Confirm backup & open wallet' }).click();
  await expect(page.getByRole('heading', { name: 'Keep it simple.' })).toBeVisible();
  await page.getByRole('button', { name: 'Receive', exact: true }).first().click();
  await expect(page.locator('.address-box')).toContainText('bcrt1q');
  const initialAddress = await page.locator('.address-box').innerText();
  await expect(page.getByRole('img', { name: 'QR code for your TensorCash receive address' })).toBeVisible();
  await page.getByRole('button', { name: 'New address', exact: true }).click();
  await expect(page.locator('.address-box')).not.toHaveText(initialAddress);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: /Download encrypted backup/ }).click();
  await page.locator('input[name="password"]').fill(PASSWORD);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download encrypted backup', exact: true }).click();
  const download = await downloadPromise;
  const backupPath = await download.path();
  if (!backupPath) throw new Error('The encrypted backup download has no readable file.');
  const backup = await readFile(backupPath, 'utf8');
  expect(backup).not.toContain(words.join(' '));
  expect(backup).not.toContain(PASSWORD);
  for (const body of requests) { expect(body).not.toContain(PASSWORD); expect(body).not.toContain(words.join(' ')); }
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your wallet, on this device.' })).toBeVisible();
  await page.locator('input[name="password"]').fill('incorrect-password');
  await page.getByRole('button', { name: 'Unlock wallet', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await unlock(page);
  const fresh = await browser.newContext({ baseURL: 'http://127.0.0.1:4173' });
  const recovery = await fresh.newPage();
  await mockRegtest(recovery);
  await recovery.goto('/');
  await recovery.getByRole('button', { name: 'Restore a wallet', exact: true }).click();
  await recovery.getByRole('button', { name: 'Encrypted file', exact: true }).click();
  await recovery.locator('input[type="file"]').setInputFiles({ name: 'wallet.json', mimeType: 'application/json', buffer: Buffer.from(backup) });
  await recovery.locator('input[name="password"]').fill(PASSWORD);
  await recovery.getByRole('button', { name: 'Restore wallet', exact: true }).click();
  await expect(recovery.getByRole('heading', { name: 'Keep it simple.' })).toBeVisible();
  await recovery.getByRole('button', { name: 'Receive', exact: true }).first().click();
  await expect(recovery.locator('.address-box')).toHaveText(initialAddress);
  await fresh.close();
});
test('Max fills the editable amount after fee, follows rate changes, preserves edits and matches review', async ({ page, browserName }) => {
  const { fixture } = await mockRegtest(page, true);
  await restorePhrase(page);
  await page.getByRole('navigation', { name: 'Wallet sections' }).getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('send-available-balance')).toHaveText('0.01 TSC');
  const amount = page.getByLabel('Amount · TSC', { exact: true });
  const max = page.getByRole('button', { name: 'Max', exact: true });
  await max.click();
  await expect(amount).toHaveValue('0.0099978');
  await expect(amount).toBeEditable();
  await expect(page.getByTestId('max-network-fee')).toHaveText('Network fee: 0.0000022 TSC');
  await page.getByLabel('Network fee rate · atomic units/vbyte').fill('3');
  await expect(amount).toHaveValue('0.0099967');
  await expect(page.getByTestId('max-network-fee')).toHaveText('Network fee: 0.0000033 TSC');
  await amount.fill('0.005');
  await expect(max).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('max-network-fee')).toHaveCount(0);
  await page.getByLabel('Network fee rate · atomic units/vbyte').fill('2');
  await expect(amount).toHaveValue('0.005');
  await page.getByLabel('Recipient address').fill(fixture.recipient);
  await max.click();
  await mkdir('artifacts/send-max', { recursive: true });
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(max).toBeVisible();
    const inputBounds = await amount.boundingBox(); const buttonBounds = await max.boundingBox();
    expect(inputBounds).not.toBeNull(); expect(buttonBounds).not.toBeNull();
    expect(buttonBounds!.x).toBeGreaterThanOrEqual(inputBounds!.x + inputBounds!.width);
    await page.screenshot({ path: `artifacts/send-max/${browserName}-${width}.png`, fullPage: true });
  }
  await page.getByRole('button', { name: 'Review transfer', exact: false }).click();
  await expect(page.locator('.review-amount')).toHaveText('0.0099978 TSC');
  await expect(page.locator('.review-list').getByText('0.0000022 TSC', { exact: true })).toBeVisible();
  await expect(page.locator('.review-list').getByText('0.01 TSC', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to edit', exact: true }).click();
  await expect(page.getByLabel('Recipient address')).toHaveValue(fixture.recipient);
  await expect(amount).toHaveValue('0.0099978');
});

test('mainnet Max uses two confirmed funds and signs the amount shown after fee', async ({ page }) => {
  const mocked = await mockRegtest(page, true, false, 'mainnet');
  mocked.setConfirmations(2, 2);
  await restorePhrase(page);
  await page.getByRole('navigation', { name: 'Wallet sections' }).getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByLabel('Recipient address').fill(mocked.fixture.recipient);
  await page.getByRole('button', { name: 'Max', exact: true }).click();
  await expect(page.getByLabel('Amount · TSC', { exact: true })).toHaveValue('0.0099978');
  await page.getByRole('button', { name: 'Review transfer', exact: false }).click();
  await expect(page.locator('.review-amount')).toHaveText('0.0099978 TSC');
  await page.getByRole('button', { name: 'Confirm & send', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'On its way.' })).toBeVisible();
  expect(mocked.broadcasts).toHaveLength(1);
  const decoded = decodeNativeTransaction(mocked.broadcasts[0]);
  expect(decoded.outputs).toHaveLength(1);
  expect(decoded.outputs[0].amountUnits).toBe('999780');
});

test('an uncertain broadcast survives lock and reload and retries identical bytes', async ({ page }) => {
  const { broadcasts, fixture } = await mockRegtest(page, true, true);
  await restorePhrase(page);
  await expect(page.locator('.balance-number')).toContainText('0.01');
  await page.getByRole('button', { name: 'Send', exact: true }).first().click();
  await page.locator('input[name="recipient"]').fill(fixture.recipient);
  await page.locator('input[name="amount"]').fill('0.005');
  await page.getByRole('button', { name: 'Review transfer' }).click();
  await expect(page.getByRole('heading', { name: 'Check every detail.' })).toBeVisible();
  await page.getByRole('button', { name: 'Confirm & send', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check & retry same transaction' })).toBeVisible();
  expect(broadcasts).toHaveLength(1);
  const original = broadcasts[0];
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('tensorcash.broadcast.')).length)).toBe(1);
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  await page.reload();
  await unlock(page);
  await expect(page.getByRole('button', { name: 'Check & retry same transaction' })).toBeVisible();
  await page.getByRole('button', { name: 'Check & retry same transaction' }).click();
  await expect(page.getByRole('heading', { name: 'On its way.' })).toBeVisible();
  expect(broadcasts).toHaveLength(2);
  expect(broadcasts[1]).toBe(original);
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('tensorcash.broadcast.')).length)).toBe(0);
});
test('recovery phrase requires reauthentication and is hidden on tab visibility loss', async ({ page }) => {
  await mockRegtest(page);
  await restorePhrase(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: /View recovery phrase/ }).click();
  await page.locator('input[name="password"]').fill('incorrect-password');
  await page.getByRole('button', { name: 'Show recovery phrase', exact: true }).click();
  await expect(page.locator('.seed-grid')).not.toBeVisible();
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Show recovery phrase', exact: true }).click();
  await expect(page.locator('.seed-grid')).toBeVisible();
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.locator('.seed-grid')).not.toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recovery phrase hidden' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Lock', exact: true })).toBeVisible();
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.getByRole('button', { name: 'Show recovery phrase again', exact: true }).click();
  await expect(page.locator('.seed-grid')).toBeVisible();
  await page.getByRole('button', { name: 'Hide recovery phrase', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Keep it simple.' })).toBeVisible();
});
test('canceling an attempted rejected transfer requires a fresh unspent-input proof', async ({ page }) => {
  const mocked = await mockRegtest(page, true, true);
  await restorePhrase(page);
  await expect(page.locator('.balance-number')).toContainText('0.01');
  await page.getByRole('button', { name: 'Send', exact: true }).first().click();
  await page.locator('input[name="recipient"]').fill(mocked.fixture.recipient);
  await page.locator('input[name="amount"]').fill('0.005');
  await page.getByRole('button', { name: 'Review transfer' }).click();
  await page.getByRole('button', { name: 'Confirm & send', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check & retry same transaction' })).toBeVisible();
  mocked.setRejection(true);
  await page.getByRole('button', { name: 'Check & retry same transaction' }).click();
  await expect(page.getByRole('button', { name: 'Cancel rejected transfer' })).toBeVisible();
  mocked.setRejection(false);
  await page.getByRole('button', { name: 'Cancel rejected transfer' }).click();
  await expect(page.getByRole('alert')).toContainText('can no longer be safely canceled');
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('tensorcash.broadcast.')).length)).toBe(1);
  mocked.setRejection(true);
  await page.getByRole('button', { name: 'Check & retry same transaction' }).click();
  await page.getByRole('button', { name: 'Cancel rejected transfer' }).click();
  await expect(page.getByRole('heading', { name: 'Make a transfer.' })).toBeVisible();
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('tensorcash.broadcast.')).length)).toBe(0);
  expect(mocked.broadcasts).toHaveLength(1);
});
for (const issue of ['authentication', 'synchronizing'] as const) {
  test(`startup recovers automatically from ${issue} without reloading or clicking retry`, async ({ page }) => {
    const mocked = await mockRegtest(page);
    mocked.setNetworkIssue(issue);
    await page.goto('/');
    const create = page.getByRole('button', { name: /^Create a wallet/ });
    const badge = page.locator('.network-badge');
    if (issue === 'authentication') {
      await expect(page.getByRole('alert')).toContainText('Core authentication is unavailable');
      await expect(create).toBeDisabled();
    } else {
      await expect(badge).toHaveText('Regtest');
      await expect(badge).toHaveClass(/network-waiting/);
      await expect(page.locator('.network-update')).toHaveCount(0);
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Retry connection', exact: true })).not.toBeVisible();
      await expect(create).toBeEnabled();
    }
    mocked.setNetworkIssue(null);
    await expect(badge).not.toHaveClass(/network-waiting/, { timeout: 35_000 });
    await expect(create).toBeEnabled();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.locator('.network-update')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Retry connection', exact: true })).not.toBeVisible();
  });
}
test('a wallet can be created while the network view is still updating', async ({ page }) => {
  const mocked = await mockRegtest(page);
  mocked.setNetworkIssue('synchronizing');
  await page.goto('/');
  await expect(page.locator('.network-badge')).toHaveText('Regtest');
  await expect(page.locator('.network-badge')).toHaveClass(/network-waiting/);
  await expect(page.locator('.network-update')).toHaveCount(0);
  await page.getByRole('button', { name: /^Create a wallet/ }).click();
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('input[name="confirmPassword"]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create & back up wallet' }).click();
  await expect(page.getByRole('heading', { name: 'Write down these 12 words' })).toBeVisible();
  const words = await page.locator('.seed-grid li').evaluateAll(nodes => nodes.map(node => node.lastChild?.textContent ?? ''));
  expect(words).toHaveLength(12);
  await expect(page.locator('.network-update')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'I have written down all 12 words' }).click();
  for (const index of [2, 5, 9]) await page.locator(`input[name="word${index}"]`).fill(words[index]);
  await page.getByRole('button', { name: 'Confirm backup & open wallet' }).click();
  await expect(page.getByRole('heading', { name: 'Keep it simple.' })).toBeVisible();
  await expect(page.locator('.network-update')).toContainText('Updating wallet data');
  await expect(page.getByTestId('wallet-sync')).toHaveText('Updating');
  await expect(page.getByTestId('balance-total')).toHaveText('—TSC');
  await expect(page.locator('.balance-actions').getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(mocked.requests.some(body => body.includes('addresses'))).toBe(false);
  mocked.setNetworkIssue(null);
  await expect(page.getByTestId('wallet-sync')).toHaveAttribute('data-sync-state', 'idle', { timeout: 35_000 });
  await expect(page.locator('.network-update')).toHaveCount(0);
  await expect(page.getByTestId('balance-total')).toHaveText('0TSC');
});
test('connection recovery preserves an existing locked vault and its password error', async ({ page }) => {
  const mocked = await mockRegtest(page);
  await restorePhrase(page);
  await page.getByRole('navigation', { name: 'Wallet sections' }).getByRole('button', { name: 'Receive', exact: true }).click();
  await expect(page.locator('.address-box')).toContainText('bcrt1q');
  const originalAddress = await page.locator('.address-box').innerText();
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  mocked.setNetworkIssue('authentication');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your wallet, on this device.' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Core authentication is unavailable');
  await expect(page.getByRole('button', { name: /^Create a wallet/ })).not.toBeVisible();
  await page.locator('input[name="password"]').fill('incorrect-password');
  await page.getByRole('button', { name: 'Unlock wallet', exact: true }).click();
  const passwordError = page.getByRole('alert').filter({ hasText: 'Password is incorrect' });
  await expect(passwordError).toBeVisible();
  mocked.setNetworkIssue(null);
  await expect(page.getByRole('alert').filter({ hasText: 'Core authentication is unavailable' })).toHaveCount(0, { timeout: 35_000 });
  await expect(passwordError).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your wallet, on this device.' })).toBeVisible();
  await expect(page.locator('input[name="password"]')).toHaveValue('incorrect-password');
  await unlock(page);
  await page.getByRole('navigation', { name: 'Wallet sections' }).getByRole('button', { name: 'Receive', exact: true }).click();
  await expect(page.locator('.address-box')).toHaveText(originalAddress);
});

test('initial unknown balance stays unknown while slow synchronization leaves navigation usable', async ({ page }) => {
  const mocked = await mockRegtest(page, true);
  mocked.holdSync();
  await restorePhrase(page, false);
  await expect(page.getByTestId('wallet-sync')).toHaveAttribute('data-sync-state', 'loading');
  await expect(page.getByTestId('balance-total')).toHaveText('—TSC');
  await expect(page.getByTestId('balance-available')).toHaveText('— TSC');
  await expect(page.getByTestId('balance-pending')).toHaveText('— TSC');
  await expect(page.getByText('0 transactions', { exact: true })).not.toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Keep your wallet safe.' })).toBeVisible();
  mocked.releaseSync();
  await expect(page.getByTestId('wallet-sync')).toHaveAttribute('data-sync-state', 'idle');
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(page.getByTestId('balance-total')).toHaveText('0.01TSC');
});

test('refresh retains balances, history and QR while incomplete or unavailable data keeps sending paused', async ({ page }) => {
  const mocked = await mockRegtest(page, true);
  await restorePhrase(page);
  await expect(page.getByTestId('balance-available')).toHaveText('0.01 TSC');
  mocked.holdSync();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByTestId('wallet-sync')).toHaveAttribute('data-sync-state', 'refreshing');
  await expect(page.getByTestId('balance-total')).toHaveText('0.01TSC');
  await expect(page.getByTestId('balance-available')).toHaveText('0.01 TSC');
  await expect(page.locator('.history-row')).toHaveCount(1);
  await expect(page.locator('.announcements .working')).not.toBeVisible();
  await page.getByRole('navigation', { name: 'Wallet sections' }).getByRole('button', { name: 'Receive', exact: true }).click();
  const qr = page.getByRole('img', { name: 'QR code for your TensorCash receive address' });
  await expect(qr).toBeVisible();
  const source = await qr.getAttribute('src');
  mocked.releaseSync();
  await expect(page.getByTestId('wallet-sync')).toHaveAttribute('data-sync-state', 'idle');
  await expect(qr).toHaveAttribute('src', source!);
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  for (const issue of ['incomplete', 'failure'] as const) {
    mocked.setSyncIssue(issue);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.getByTestId('wallet-sync')).toHaveAttribute('data-sync-state', 'stale');
    await expect(page.getByTestId('balance-total')).toHaveText('0.01TSC');
    await expect(page.getByTestId('balance-available')).toHaveText('0.01 TSC');
    await expect(page.locator('.history-row')).toHaveCount(1);
    await expect(page.locator('.balance-actions').getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  }
  mocked.setSyncIssue(null); mocked.setFeesUnavailable(true);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByTestId('wallet-sync')).toHaveAttribute('data-sync-state', 'stale');
  await expect(page.getByTestId('balance-total')).toHaveText('0.01TSC');
  await expect(page.getByText(/Fee estimates unavailable/)).toBeVisible();
  mocked.setFeesUnavailable(false);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByTestId('wallet-sync')).toHaveAttribute('data-sync-state', 'idle');
  await expect(page.locator('.balance-actions').getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
});

test('accepted send shows pending change and activity immediately through index lag, refresh and reload', async ({ page }) => {
  const mocked = await mockRegtest(page, true);
  mocked.setExplorer('https://tscscan.xyz');
  await restorePhrase(page);
  await page.getByRole('button', { name: 'Send', exact: true }).first().click();
  await page.locator('input[name="recipient"]').fill(mocked.fixture.recipient);
  await page.locator('input[name="amount"]').fill('0.005');
  await page.getByRole('button', { name: 'Review transfer' }).click();
  mocked.holdSync();
  await page.getByRole('button', { name: 'Confirm & send', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'On its way.' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'View transaction in explorer' })).toHaveAttribute('href', `https://tscscan.xyz/tx/${decodeNativeTransaction(mocked.broadcasts[0]).txid}`);
  await page.getByRole('button', { name: 'View activity', exact: true }).click();
  const ownChange = formatTsc(decodeNativeTransaction(mocked.broadcasts[0]).outputs[1].amountUnits);
  await expect(page.getByTestId('balance-total')).toHaveText(`${ownChange}TSC`);
  await expect(page.getByTestId('balance-available')).toHaveText('0 TSC');
  await expect(page.getByTestId('balance-pending')).toHaveText(`${ownChange} TSC`);
  await expect(page.locator('.history-row').filter({ hasText: 'Sending' })).toHaveCount(1);
  mocked.releaseSync();
  await expect(page.getByTestId('wallet-sync')).toHaveAttribute('data-sync-state', 'idle');
  await expect(page.getByTestId('balance-pending')).toHaveText(`${ownChange} TSC`);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByTestId('wallet-sync')).toHaveAttribute('data-sync-state', 'idle');
  await expect(page.getByTestId('balance-total')).toHaveText(`${ownChange}TSC`);
  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  await page.reload(); await unlock(page);
  await expect(page.getByTestId('wallet-sync')).toHaveAttribute('data-sync-state', 'idle');
  await expect(page.getByTestId('balance-pending')).toHaveText(`${ownChange} TSC`);
  await expect(page.getByTestId('balance-available')).toHaveText('0 TSC');
  expect(mocked.broadcasts).toHaveLength(1);
});

test('user activity extends the idle window and returning after five idle minutes locks immediately', async ({ page }) => {
  // Advancing the main-thread clock must not expire the RPC timeout before a
  // real Worker has had a turn to acknowledge the preceding user event.
  await page.addInitScript(() => {
    const pending = new Set<number>();
    const watched = new WeakSet<Worker>();
    const original = Worker.prototype.postMessage;
    Object.defineProperty(window, '__pendingWalletCalls', { value: () => pending.size });
    Worker.prototype.postMessage = function (message: unknown, options?: StructuredSerializeOptions | Transferable[]) {
      const request = message as { id?: number; method?: string };
      if (typeof request?.id === 'number' && typeof request.method === 'string') {
        if (!watched.has(this)) {
          watched.add(this);
          this.addEventListener('message', event => { pending.delete(event.data.id); });
        }
        pending.add(request.id);
      }
      original.call(this, message, Array.isArray(options) ? { transfer: options } : options);
    };
  });
  const workerSettled = () => expect.poll(() => page.evaluate(() =>
    (window as unknown as { __pendingWalletCalls: () => number }).__pendingWalletCalls())).toBe(0);
  await mockRegtest(page);
  await restorePhrase(page);
  await workerSettled();
  await page.clock.install({ time: new Date() });
  await page.clock.fastForward(4 * 60_000);
  await workerSettled();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await workerSettled();
  await page.clock.fastForward(4 * 60_000);
  await workerSettled();
  await expect(page.getByRole('heading', { name: 'Keep your wallet safe.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Lock', exact: true })).toBeVisible();
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.getByRole('button', { name: 'Lock', exact: true })).toBeVisible();
  // Simulate a suspended background tab: wall time advances without timer callbacks.
  const currentTime = await page.evaluate(() => Date.now());
  await page.clock.setSystemTime(currentTime + 5 * 60_000 + 1);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.getByRole('heading', { name: 'Your wallet, on this device.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Lock', exact: true })).not.toBeVisible();
});

for (const required of [2, 3]) test(`incoming activity shows receiving and confirmation progress until ${required} required confirmations`, async ({ page }) => {
  const mocked = await mockRegtest(page, true);
  mocked.setConfirmations(0, required);
  await restorePhrase(page);
  const row = page.locator('.history-row');
  for (const confirmations of Array.from({ length: required + 1 }, (_, index) => index)) {
    if (confirmations > 0) {
      mocked.setConfirmations(confirmations, required);
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await expect(page.getByTestId('wallet-sync')).toHaveAttribute('data-sync-state', 'idle');
    }
    await expect(row).toContainText(`${confirmations}/${required}`);
    await expect(row.locator('.transaction-description > strong')).toHaveText(confirmations < required ? 'Receiving' : 'Received');
    await expect(page.getByTestId('balance-pending')).toHaveText(confirmations < required ? '0.01 TSC' : '0 TSC');
    await expect(page.getByTestId('balance-available')).toHaveText(confirmations < required ? '0 TSC' : '0.01 TSC');
    if (confirmations === required) await expect(row.locator('.tx-status')).toContainText('Confirmed');
  }
});

test('overview stays compact and network details are available on demand at desktop and narrow widths', async ({ page }) => {
  const mocked = await mockRegtest(page, true, false, 'mainnet');
  mocked.setConfirmations(1, 3);
  mocked.setTiming({ averageBlockSeconds: 480, blockTimeSampleSize: 20, lastBlockTime: 1_790_000_000 });
  await restorePhrase(page);
  const card = page.getByRole('region', { name: 'Wallet balances' });
  const details = card.locator('details.network-details');
  await expect(card.locator('.balance-main .balance-meta')).toHaveCount(1);
  await expect(card.locator('.balance-main .balance-meta')).toHaveText(/^Updated \d/);
  await expect(card.locator('.balance-details').getByText('Available', { exact: true })).toBeVisible();
  await expect(card.locator('.balance-details').getByText('Pending', { exact: true })).toBeVisible();
  await expect(card.getByTestId('balance-unsupported')).toHaveCount(0);
  await expect(page.getByText(/Payments become available/)).toHaveCount(0);
  await expect(details).not.toHaveAttribute('open');
  await expect(page.getByTestId('block-timing')).not.toBeVisible();
  await expect(page.locator('.history-row .tx-status')).toHaveText('Pending · 1/3');
  await expect(page.locator('.confirmation-estimate')).toHaveText('approx. 16 min');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeVisible();
    const layout = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > innerWidth,
      pendingTop: document.querySelector('[data-testid="balance-pending"]')!.getBoundingClientRect().top,
      availableTop: document.querySelector('[data-testid="balance-available"]')!.getBoundingClientRect().top,
    }));
    expect(layout.overflow).toBe(false);
    expect(Math.abs(layout.pendingTop - layout.availableTop)).toBeLessThan(1);
    await page.screenshot({ path: `artifacts/usability-overview-${width}.png`, fullPage: true });
  }
  await details.locator('summary').click();
  await expect(details).toHaveAttribute('open');
  await expect(details.getByText('Confirmations to spend', { exact: true })).toBeVisible();
  await expect(page.getByTestId('block-timing')).toContainText('approx. 8 min');
  await expect(page.getByTestId('block-timing')).toContainText('Last 20 blocks');
  await details.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(details).not.toHaveAttribute('open');
});
