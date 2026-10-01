import { test, expect, type Page } from '@playwright/test';
import { Transaction } from '@scure/btc-signer';
import { hex } from '@scure/base';
import { deriveAccount, deriveAddress } from '../../src/core/keys';
import { decodeNativeTransaction } from '../../src/core/raw';
import { networkConfig } from '../../src/core/network';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'wallet cache password 2026';
async function mockGateway(page: Page) {
  const account = deriveAccount(PHRASE, 'regtest'); const receive = deriveAddress(account, 'regtest', 0, 0);
  const selectedReceive = deriveAddress(account, 'regtest', 0, 1); const secondReceive = deriveAddress(account, 'regtest', 0, 2);
  const thirdReceive = deriveAddress(account, 'regtest', 0, 3); account.wipePrivateData();
  const parent = new Transaction({ version: 2, allowUnknownInputs: true });
  parent.addInput({ txid: '11'.repeat(32), index: 0, sequence: 0xffffffff });
  parent.addOutput({ amount: 1_000_000n, script: hex.decode(receive.scriptHex) });
  const rawParent = hex.encode(parent.toBytes(true, false)); const txid = decodeNativeTransaction(rawParent).txid;
  let blocked = false; let syncFails = false; let syncRequests = 0;
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const network = { network: 'regtest', chain: 'regtest', genesisHash: networkConfig('regtest').genesisHash,
      height: 105, indexedHeight: blocked ? 100 : 105, tipHash: 'aa'.repeat(32), ready: !blocked,
      observedAt: new Date().toISOString(), explorerUrl: null, minConfirmations: 3, coinbaseMaturity: 100 };
    if (path.endsWith('/network')) { await route.fulfill({ json: network }); return; }
    if (path.endsWith('/fees')) {
      await route.fulfill({ json: { relayFloorUnitsPerVbyte: '1', mempoolFloorUnitsPerVbyte: '1', suggestedRate: '2', observedAt: new Date().toISOString() } }); return;
    }
    if (path.endsWith('/wallet/sync')) {
      syncRequests += 1;
      if (syncFails) { await route.fulfill({ status: 503, json: { error: { message: 'Temporary synchronization failure' } } }); return; }
      const addresses = (route.request().postDataJSON() as { addresses: string[] }).addresses;
      const funded = addresses.includes(receive.address);
      await route.fulfill({ json: { network, addresses: addresses.map(address => ({ address, used: address === receive.address })),
        utxos: funded ? [{ txid, vout: 0, address: receive.address, scriptHex: receive.scriptHex, amountUnits: '1000000',
          confirmations: 5, blockHeight: 101, coinbase: false, classification: 'native', rawParent, verified: true }] : [],
        history: funded ? [{ txid, deltaUnits: '1000000', feeUnits: null, status: 'confirmed', confirmations: 5, blockHeight: 101, timestamp: 1790000000 }] : [],
        complete: true, warnings: [], observedAt: network.observedAt, mempoolFingerprint: 'bb'.repeat(32) } }); return;
    }
    await route.fulfill({ status: 404, json: { message: 'Unmocked endpoint' } });
  });
  return { receive, selectedReceive, secondReceive, thirdReceive, txid, rawParent, setBlocked: (value: boolean) => { blocked = value; },
    setSyncFails: (value: boolean) => { syncFails = value; }, syncRequests: () => syncRequests };
}
async function restore(page: Page, wait = true) {
  await page.goto('/'); await page.getByRole('button', { name: 'Restore a wallet', exact: true }).click();
  await page.locator('textarea[name="mnemonic"]').fill(PHRASE);
  await page.locator('input[name="password"]').fill(PASSWORD); await page.locator('input[name="confirmPassword"]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Restore wallet', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Keep it simple.' })).toBeVisible();
  if (wait) await expect(page.getByTestId('wallet-sync')).toHaveAttribute('data-sync-state', 'idle');
}
async function unlock(page: Page) {
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Unlock wallet', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Keep it simple.' })).toBeVisible();
}
async function readStored(page: Page, key: string): Promise<string | null> {
  return page.evaluate(async storedKey => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('tensorcash-wallet-v1', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try { return await new Promise<string | null>((resolve, reject) => {
      const request = db.transaction('vault', 'readonly').objectStore('vault').get(storedKey);
      request.onsuccess = () => resolve(typeof request.result === 'string' ? request.result : null); request.onerror = () => reject(request.error);
    }); } finally { db.close(); }
  }, key);
}
async function setStoredCache(page: Page, value: string) {
  await page.evaluate(async cache => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('tensorcash-wallet-v1', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try { await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('vault', 'readwrite'); tx.objectStore('vault').put(cache, 'display-cache');
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    }); } finally { db.close(); }
  }, value);
}
test('real Worker: encrypted last verified balance survives lock and reload, with sending paused until live sync', async ({ page }) => {
  const gateway = await mockGateway(page); await restore(page);
  await expect(page.getByTestId('balance-total')).toHaveText('0.01TSC');
  await expect.poll(() => readStored(page, 'display-cache')).not.toBeNull();
  const storedCache = (await readStored(page, 'display-cache'))!;
  for (const value of [PHRASE, PASSWORD, gateway.receive.address, gateway.txid, gateway.rawParent]) expect(storedCache).not.toContain(value);
  expect(JSON.parse(storedCache).format).toBe('tensorcash-display-cache');
  const verifiedAt = await page.locator('.balance-meta time').getAttribute('datetime');
  gateway.setBlocked(true);
  await page.getByRole('button', { name: 'Lock', exact: true }).click(); await unlock(page);
  await expect(page.getByTestId('balance-total')).toHaveText('0.01TSC');
  await expect(page.locator('.balance-main > .eyebrow')).toHaveText('Last known balance');
  await expect(page.locator('.balance-meta time')).toHaveAttribute('datetime', verifiedAt!);
  await expect(page.locator('.balance-meta')).toContainText('Last verified');
  await expect(page.locator('.balance-actions').getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await expect(page.locator('.history-row')).toHaveCount(1);
  await page.getByRole('button', { name: 'Receive', exact: true }).first().click();
  await expect(page.locator('.address-box')).toHaveText(gateway.selectedReceive.address);
  await page.reload(); await unlock(page);
  await expect(page.getByTestId('balance-total')).toHaveText('0.01TSC');
  await expect(page.locator('.balance-main > .eyebrow')).toHaveText('Last known balance');
  await expect(page.locator('.balance-actions').getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await page.getByRole('navigation', { name: 'Wallet sections' }).getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('send-available-balance')).toHaveText('0.01 TSC');
  await expect(page.getByRole('button', { name: 'Max', exact: true })).toBeDisabled();
  await page.getByRole('navigation', { name: 'Wallet sections' }).getByRole('button', { name: 'Overview', exact: true }).click();
  gateway.setBlocked(false);
  await expect(page.getByTestId('wallet-sync')).toHaveAttribute('data-sync-state', 'idle', { timeout: 12_000 });
  await expect(page.locator('.balance-main > .eyebrow')).toHaveText('Total balance');
  await expect(page.locator('.balance-actions').getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
});
test('real Worker: choosing a new receive address survives cached lock and reload without reissuing it', async ({ page }) => {
  const gateway = await mockGateway(page); await restore(page);
  await expect.poll(() => readStored(page, 'display-cache')).not.toBeNull();
  await page.getByRole('button', { name: 'Receive', exact: true }).first().click();
  await expect(page.locator('.address-box')).toHaveText(gateway.selectedReceive.address);
  await page.getByRole('button', { name: 'New address', exact: true }).click();
  await expect(page.locator('.address-box')).toHaveText(gateway.secondReceive.address);
  gateway.setBlocked(true);
  await page.getByRole('button', { name: 'Lock', exact: true }).click(); await unlock(page);
  await page.getByRole('button', { name: 'Receive', exact: true }).first().click();
  await expect(page.locator('.address-box')).toHaveText(gateway.secondReceive.address);
  await page.reload(); await unlock(page);
  await page.getByRole('button', { name: 'Receive', exact: true }).first().click();
  await expect(page.locator('.address-box')).toHaveText(gateway.secondReceive.address);
  await page.getByRole('button', { name: 'New address', exact: true }).click();
  await expect(page.locator('.address-box')).toHaveText(gateway.thirdReceive.address);
});
test('real Worker: damaged display cache is ignored and an unknown balance is never presented as zero', async ({ page }) => {
  const gateway = await mockGateway(page); await restore(page);
  await expect.poll(() => readStored(page, 'display-cache')).not.toBeNull();
  const cache = JSON.parse((await readStored(page, 'display-cache'))!);
  cache.ciphertext = (cache.ciphertext.slice(0, 2) === '00' ? 'ff' : '00') + cache.ciphertext.slice(2);
  await setStoredCache(page, JSON.stringify(cache)); gateway.setBlocked(true);
  await page.reload(); await unlock(page);
  await expect(page.getByTestId('wallet-sync')).toHaveAttribute('data-sync-state', 'stale');
  await expect(page.getByTestId('balance-total')).toHaveText('—TSC');
  await expect(page.locator('.balance-actions').getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  gateway.setBlocked(false);
  await expect(page.getByTestId('balance-total')).toHaveText('0.01TSC', { timeout: 12_000 });
});
test('real Worker: a wallet without a completed first refresh has no cached zero balance', async ({ page }) => {
  const gateway = await mockGateway(page); gateway.setSyncFails(true); await restore(page, false);
  await expect(page.getByTestId('wallet-sync')).toHaveAttribute('data-sync-state', 'stale');
  await expect(page.getByTestId('balance-total')).toHaveText('—TSC');
  expect(await readStored(page, 'display-cache')).toBeNull();
  await page.getByRole('button', { name: 'Lock', exact: true }).click(); await unlock(page);
  await expect(page.getByTestId('balance-total')).toHaveText('—TSC');
  expect(await readStored(page, 'display-cache')).toBeNull();
});
