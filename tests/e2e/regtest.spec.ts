import { test, expect, type Page } from '@playwright/test';
import { writeFile, mkdir } from 'node:fs/promises';
import { prepareRegtestFixture, regtestRpc } from '../../scripts/regtest-rpc';
import { parseTsc } from '../../src/ui/format';

const PASSWORD = 'regtest-browser-only-password-2026';
async function settled(page: Page) {
  await expect(page.getByTestId('wallet-sync')).toHaveAttribute('data-sync-state', 'idle', { timeout: 60000 });
  await expect(page.locator('.address-box')).toHaveCount(0);
}
async function receiveAddress(page: Page): Promise<string> {
  await page.getByRole('navigation', { name: 'Wallet sections' }).getByRole('button', { name: 'Receive', exact: true }).click();
  await expect(page.locator('.address-box')).toContainText('bcrt1q');
  const address = (await page.locator('.address-box').innerText()).trim();
  await page.getByRole('navigation', { name: 'Wallet sections' }).getByRole('button', { name: 'Overview', exact: true }).click();
  return address;
}
async function send(page: Page, recipient: string, amount: string): Promise<string> {
  await page.getByRole('navigation', { name: 'Wallet sections' }).getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByLabel('Recipient address').fill(recipient);
  await page.getByLabel('Amount · TSC', { exact: true }).fill(amount);
  await page.getByLabel('Network fee rate · atomic units/vbyte').fill('2');
  await page.getByRole('button', { name: 'Review transfer' }).click();
  await expect(page.getByRole('heading', { name: 'Check every detail.' })).toBeVisible();
  await expect(page.locator('.review-list')).toContainText(recipient);
  await page.getByRole('button', { name: 'Confirm & send' }).click();
  await expect(page.getByRole('heading', { name: 'On its way.' })).toBeVisible({ timeout: 60000 });
  const txid = (await page.locator('.review-list dd.mono').innerText()).trim();
  expect(/^[0-9a-f]{64}$/.test(txid)).toBe(true);
  await page.getByRole('button', { name: 'View activity' }).click();
  return txid;
}

async function sendMax(page: Page, recipient: string) {
  await page.getByRole('navigation', { name: 'Wallet sections' }).getByRole('button', { name: 'Send', exact: true }).click();
  const availableUnits = parseTsc((await page.getByTestId('send-available-balance').innerText()).replace('TSC', '').trim());
  await page.getByLabel('Recipient address').fill(recipient);
  await page.getByLabel('Network fee rate · atomic units/vbyte').fill('2');
  await page.getByRole('button', { name: 'Max', exact: true }).click();
  const amountUnits = parseTsc(await page.getByLabel('Amount · TSC', { exact: true }).inputValue());
  await page.getByRole('button', { name: 'Review transfer', exact: false }).click();
  await expect(page.getByRole('heading', { name: 'Check every detail.' })).toBeVisible();
  const reviewAmount = (await page.locator('.review-amount').innerText()).replace('TSC', '').trim();
  expect(parseTsc(reviewAmount)).toBe(amountUnits);
  const feeText = await page.locator('.review-list > div').filter({ has: page.locator('dt', { hasText: /^Network fee$/ }) }).locator('dd').innerText();
  const feeUnits = parseTsc(feeText.replace('TSC', '').trim());
  expect(BigInt(amountUnits) + BigInt(feeUnits)).toBe(BigInt(availableUnits));
  await page.getByRole('button', { name: 'Confirm & send', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'On its way.' })).toBeVisible({ timeout: 60000 });
  const txid = (await page.locator('.review-list dd.mono').innerText()).trim();
  await page.getByRole('button', { name: 'View activity', exact: true }).click();
  await expect(page.getByTestId('balance-total')).toHaveText('0TSC');
  return { txid, availableUnits, amountUnits, feeUnits };
}

test('real TensorCash Core: browser receives, signs two inputs and recovers change on a clean profile', async ({ page, browser, browserName }) => {
  test.setTimeout(180000);
  const fixture = await prepareRegtestFixture();
  const outgoing: string[] = [];
  page.on('request', request => { if (request.postData()) outgoing.push(request.postData()!); });
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a wallet' }).click();
  await page.locator('input[name=password]').fill(PASSWORD);
  await page.locator('input[name=confirmPassword]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create & back up wallet' }).click();
  await expect(page.locator('.seed-grid li')).toHaveCount(12);
  const words = await page.locator('.seed-grid li').evaluateAll(nodes => nodes.map(node => [...node.childNodes].filter(child => child.nodeType === Node.TEXT_NODE).map(child => child.textContent).join('').trim()));
  const mnemonic = words.join(' ');
  await page.getByRole('button', { name: 'I have written down all 12 words' }).click();
  for (const number of [3, 6, 10]) await page.getByLabel(`Word ${number}`, { exact: true }).fill(words[number - 1]);
  await page.getByRole('button', { name: 'Confirm backup & open wallet' }).click();
  await settled(page);
  const address = await receiveAddress(page);
  for (let index = 0; index < 2; index++) await regtestRpc('sendtoaddress', { address, amount: 1, fee_rate: 2 }, 'wallet-web-miner');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await settled(page);
  await expect(page.getByTestId('balance-total')).toHaveText('2TSC');
  await expect(page.getByTestId('balance-available')).toHaveText(/0\s*TSC/);
  await expect(page.getByTestId('balance-pending')).toHaveText(/2\s*TSC/);
  await expect(page.locator('.history-row')).toHaveCount(2);
  await expect(page.locator('.history-row').filter({ hasText: 'Receiving' }).filter({ hasText: '0/2' })).toHaveCount(2);
  await regtestRpc('generatetoaddress', [1, fixture.minerAddress]);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await settled(page);
  await expect(page.getByTestId('balance-available')).toHaveText(/0\s*TSC/);
  await expect(page.getByTestId('balance-pending')).toHaveText(/2\s*TSC/);
  await expect(page.locator('.history-row').filter({ hasText: 'Receiving' }).filter({ hasText: '1/2' })).toHaveCount(2);
  await regtestRpc('generatetoaddress', [1, fixture.minerAddress]);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await settled(page);
  await expect(page.locator('.balance-number')).toHaveText('2TSC');
  const first = await send(page, fixture.recipient, '1.5');
  const firstTx = await regtestRpc<{ vin: unknown[]; vout: { value: number; scriptPubKey: { address?: string } }[] }>('getrawtransaction', [first, true]);
  expect(firstTx.vin).toHaveLength(2);
  expect(firstTx.vout.some(output => output.value === 1.5 && output.scriptPubKey.address === fixture.recipient)).toBe(true);
  // The full input is spent, but its change stays visible before confirmation.
  await expect(page.getByTestId('balance-available')).toHaveText(/0\s*TSC/);
  const unconfirmedChange = firstTx.vout.filter(output => output.scriptPubKey.address !== fixture.recipient)
    .reduce((total, output) => total + output.value, 0);
  await expect.poll(async () => Number((await page.getByTestId('balance-total').innerText()).replace('TSC', '').trim()))
    .toBeCloseTo(unconfirmedChange, 8);
  await expect(page.locator('.history-row').filter({ hasText: 'Sending' }).filter({ hasText: '0/2' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await settled(page);
  await expect.poll(async () => Number((await page.getByTestId('balance-pending').innerText()).replace('TSC', '').trim()))
    .toBeCloseTo(unconfirmedChange, 8);
  await regtestRpc('generatetoaddress', [2, fixture.minerAddress]);
  const storage = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('tensorcash-wallet-v1'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error('storage unavailable')); });
    const value = await new Promise<unknown>((resolve, reject) => { const request = db.transaction('vault').objectStore('vault').get('active'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error('storage unavailable')); });
    db.close();
    return JSON.stringify({ vault: value, local: { ...localStorage }, session: { ...sessionStorage } });
  });
  expect(storage.includes(mnemonic) || storage.includes(PASSWORD)).toBe(false);
  expect(outgoing.some(body => body.includes(mnemonic) || body.includes(PASSWORD))).toBe(false);
  await page.close();

  const context = await browser.newContext();
  const recovered = await context.newPage();
  const restoredRequests: string[] = [];
  recovered.on('request', request => { if (request.postData()) restoredRequests.push(request.postData()!); });
  try {
    await recovered.goto('http://127.0.0.1:4173/');
    await recovered.getByRole('button', { name: 'Restore a wallet' }).click();
    await recovered.locator('textarea[name=mnemonic]').fill(mnemonic);
    await recovered.locator('input[name=password]').fill(PASSWORD);
    await recovered.locator('input[name=confirmPassword]').fill(PASSWORD);
    await recovered.getByRole('button', { name: 'Restore wallet', exact: true }).click();
    await settled(recovered);
    await expect(recovered.locator('.history-row')).toHaveCount(3);
    const balance = await recovered.locator('.balance-number').innerText();
    expect(Number(balance.replace('TSC', '').trim())).toBeGreaterThan(0.49);
    const second = await send(recovered, fixture.recipient, '0.1');
    await regtestRpc('generatetoaddress', [2, fixture.minerAddress]);
    const finalTx = await regtestRpc<{ confirmations: number; amount: number }>('gettransaction', [second], 'wallet-web-recipient');
    expect(finalTx.confirmations).toBeGreaterThanOrEqual(2);
    expect(finalTx.amount).toBe(0.1);
    await recovered.getByRole('button', { name: 'Refresh', exact: true }).click();
    await settled(recovered);
    const maximum = await sendMax(recovered, fixture.recipient);
    const maxTx = await regtestRpc<{ vout: { value: number; scriptPubKey: { address?: string } }[] }>('getrawtransaction', [maximum.txid, true]);
    expect(maxTx.vout).toHaveLength(1);
    expect(maxTx.vout[0].scriptPubKey.address).toBe(fixture.recipient);
    expect(parseTsc(maxTx.vout[0].value.toFixed(8))).toBe(maximum.amountUnits);
    await regtestRpc('generatetoaddress', [2, fixture.minerAddress]);
    const confirmedMax = await regtestRpc<{ confirmations: number; amount: number }>('gettransaction', [maximum.txid], 'wallet-web-recipient');
    expect(confirmedMax.confirmations).toBeGreaterThanOrEqual(2);
    expect(restoredRequests.some(body => body.includes(mnemonic) || body.includes(PASSWORD))).toBe(false);
    const watch = await regtestRpc<{ private_keys_enabled: boolean }>('getwalletinfo', [], 'wallet-web-watch');
    expect(watch.private_keys_enabled).toBe(false);
    await mkdir('artifacts/evidence', { recursive: true });
    await writeFile(`artifacts/evidence/browser-${browserName}.json`, JSON.stringify({
      generatedAt: new Date().toISOString(), browser: browserName, network: 'isolated-regtest',
      createBackup: true, receiveAddress: address, firstTxid: first, firstInputCount: firstTx.vin.length,
      incomingMempoolVisible: true, outgoingChangeVisibleBeforeConfirmation: true,
      requiredConfirmations: 2, oneConfirmationStillPending: true, twoConfirmationsSpendable: true,
      cleanProfileSeedRecovery: true, recoveredChangeBalance: balance, secondTxid: second,
      secondConfirmations: finalTx.confirmations, noPlaintextSecretInStorageOrRequests: true, watchOnlyGateway: true,
      sendMax: maximum, sendMaxHasNoChange: true, sendMaxSpentAvailableAfterFee: true,
      sendMaxConfirmations: confirmedMax.confirmations,
    }, null, 2) + '\n');
  } finally { await context.close(); }
});
