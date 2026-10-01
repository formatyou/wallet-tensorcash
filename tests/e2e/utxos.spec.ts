import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { prepareRegtestFixture, regtestRpc, assertIsolatedRegtest } from '../../scripts/regtest-rpc';
import { decodeNativeTransaction } from '../../src/core/raw';
import { formatTsc } from '../../src/ui/format';

const PASSWORD = 'utxo-regtest-browser-password-2026';
async function createWallet(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Create a wallet' }).click();
  await page.locator('input[name=password]').fill(PASSWORD);
  await page.locator('input[name=confirmPassword]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create & back up wallet' }).click();
  await expect(page.locator('.seed-grid li')).toHaveCount(12);
  const words = await page.locator('.seed-grid li').evaluateAll(nodes => nodes.map(node => [...node.childNodes]
    .filter(child => child.nodeType === Node.TEXT_NODE).map(child => child.textContent).join('').trim()));
  await page.getByRole('button', { name: 'I have written down all 12 words' }).click();
  for (const number of [3, 6, 10]) await page.getByLabel(`Word ${number}`, { exact: true }).fill(words[number - 1]);
  await page.getByRole('button', { name: 'Confirm backup & open wallet' }).click();
  await expect(page.getByTestId('wallet-sync')).toHaveAttribute('data-sync-state', 'idle');
}

async function reviewAndSend(page: Page) {
  await page.getByRole('button', { name: 'Review transfer' }).click();
  await expect(page.getByRole('heading', { name: 'Check every detail.' })).toBeVisible();
  await page.getByRole('button', { name: 'Confirm & send' }).click();
  await expect(page.getByRole('heading', { name: 'On its way.' })).toBeVisible();
  return (await page.locator('.review-list dd.mono').innerText()).trim();
}

test('separate UTXOs allow consecutive payments before confirmation and Max combines the remaining available inputs', async ({ page, browserName }) => {
  test.setTimeout(180_000);
  const fixture = await prepareRegtestFixture();
  const recipientB = await regtestRpc<string>('getnewaddress', ['', 'bech32'], 'wallet-web-recipient');
  const recipientC = await regtestRpc<string>('getnewaddress', ['', 'bech32'], 'wallet-web-recipient');
  const broadcasts: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname.endsWith('/tx/broadcast')) broadcasts.push((request.postDataJSON() as { rawHex: string }).rawHex);
  });
  await createWallet(page);
  const nav = page.getByRole('navigation', { name: 'Wallet sections' });
  await nav.getByRole('button', { name: 'Receive', exact: true }).click();
  await expect(page.locator('.address-box')).toContainText('bcrt1q');
  const address = (await page.locator('.address-box').innerText()).trim();
  const funding: string[] = [];
  for (const amount of [0.01, 0.012, 0.013, 0.014, 0.021]) {
    await assertIsolatedRegtest();
    funding.push(await regtestRpc<string>('sendtoaddress', { address, amount, fee_rate: 2 }, 'wallet-web-miner'));
  }
  await regtestRpc('generatetoaddress', [2, fixture.minerAddress]);
  await nav.getByRole('button', { name: 'Overview', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByTestId('balance-available')).toHaveText('0.07 TSC');
  const details = page.getByTestId('balance-breakdown');
  await expect(details).not.toHaveAttribute('open', '');
  await details.locator('summary').click();
  await expect(details.locator('.utxo-row[data-status=available]')).toHaveCount(5);
  await expect(details.locator('summary')).toContainText('5 available · 0 pending');
  for (const txid of funding) await expect(details.locator('.utxo-row').filter({ hasText: txid })).toHaveCount(1);
  const layoutChecks: { width: number; overflow: boolean }[] = [];
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    expect(overflow).toBe(false);
    layoutChecks.push({ width, overflow });
    await page.screenshot({ path: `artifacts/utxos/${browserName}-${width}.png` });
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  await nav.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByLabel('Recipient address').fill(fixture.recipient);
  await page.getByLabel('Amount · TSC', { exact: true }).fill('0.01');
  await page.getByLabel('Network fee rate · atomic units/vbyte').fill('2');
  const first = await reviewAndSend(page);
  await expect(page.getByRole('button', { name: 'Send another', exact: true })).toBeEnabled();
  // These remaining coins were not consumed by the first pending payment.
  await page.getByRole('button', { name: 'Send another', exact: true }).click();
  await expect(page.getByTestId('send-available-balance')).toHaveText('0.058 TSC');
  await page.getByLabel('Recipient address').fill(recipientB);
  // No remaining single output covers this payment, so two are required.
  await page.getByLabel('Amount · TSC', { exact: true }).fill('0.025');
  const second = await reviewAndSend(page);
  await expect(page.getByRole('button', { name: 'Send another', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'View activity', exact: true }).click();
  await expect(page.getByTestId('balance-available')).toHaveText('0.023 TSC');
  await page.getByTestId('balance-breakdown').locator('summary').click();
  await expect(page.locator('.utxo-row[data-status=available]')).toHaveCount(2);
  await expect(page.locator('.utxo-row[data-status=pending]')).toHaveCount(2);
  await expect(page.locator('.utxo-row').filter({ hasText: 'Change from a payment' })).toHaveCount(2);

  await nav.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByLabel('Recipient address').fill(recipientC);
  await page.getByRole('button', { name: 'Max', exact: true }).click();
  const maxAmount = await page.getByLabel('Amount · TSC', { exact: true }).inputValue();
  const max = await reviewAndSend(page);
  await expect(page.getByRole('button', { name: 'Send another', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'View activity', exact: true }).click();
  await expect(page.getByTestId('balance-available')).toHaveText('0 TSC');
  await expect(page.locator('.balance-actions').getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await page.getByTestId('balance-breakdown').locator('summary').click();
  await expect(page.locator('.utxo-row[data-status=available]')).toHaveCount(0);
  await expect(page.locator('.utxo-row[data-status=pending]')).toHaveCount(2);
  expect(broadcasts).toHaveLength(3);
  const txs = broadcasts.map(decodeNativeTransaction);
  expect(txs.map(tx => tx.txid)).toEqual([first, second, max]);
  expect(txs.map(tx => tx.inputs.length)).toEqual([1, 2, 2]);
  expect(txs[0].inputs.map(input => input.txid)).toEqual([funding[1]]);
  expect(txs[1].inputs.map(input => input.txid)).toEqual([funding[4], funding[3]]);
  expect(txs[2].inputs.map(input => input.txid)).toEqual([funding[2], funding[0]]);
  expect(txs[2].outputs).toHaveLength(1);
  const outpoints = txs.flatMap(tx => tx.inputs.map(input => `${input.txid}:${input.vout}`));
  expect(new Set(outpoints).size).toBe(5);
  for (const tx of txs) for (const input of tx.inputs) expect(funding).toContain(input.txid);
  const maxEntry = await regtestRpc<{ fees: { base: number } }>('getmempoolentry', [max]);
  expect(txs[2].outputs[0].amountUnits).toBe(String(2_300_000n - BigInt(Math.round(maxEntry.fees.base * 100_000_000))));
  expect(maxAmount).toBe(formatTsc(txs[2].outputs[0].amountUnits));
  const pool = await regtestRpc<string[]>('getrawmempool');
  for (const txid of [first, second, max]) expect(pool).toContain(txid);
  await regtestRpc('generatetoaddress', [2, fixture.minerAddress]);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByTestId('balance-pending')).toHaveText('0 TSC');
  await expect(page.locator('.utxo-row[data-status=available]')).toHaveCount(2);
  for (const txid of [first, second, max]) {
    expect((await regtestRpc<{ confirmations: number }>('gettransaction', [txid], 'wallet-web-recipient')).confirmations).toBeGreaterThanOrEqual(2);
  }
  await mkdir('artifacts/evidence', { recursive: true });
  await writeFile(`artifacts/evidence/utxos-regtest-${browserName}.json`, JSON.stringify({
    generatedAt: new Date().toISOString(), status: 'passed', browser: browserName, network: 'regtest',
    fundingTxids: funding, paymentTxids: [first, second, max], inputCounts: txs.map(tx => tx.inputs.length),
    maxAmountTsc: maxAmount, layoutChecks, mainnetFundsSent: false,
    checks: ['UTXO details', 'second payment before first confirms', 'disjoint confirmed inputs',
      'ordinary payment combines two inputs', 'Max combines remaining two inputs and subtracts fee',
      'pending change excluded', 'all three transactions coexist in mempool and confirm', 'pending change becomes available'],
  }, null, 2) + '\n');
});
