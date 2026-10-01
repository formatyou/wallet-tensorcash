import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { prepareRegtestFixture, regtestRpc, assertIsolatedRegtest } from '../../scripts/regtest-rpc';
import { deriveAccount, deriveAddress, newMnemonic } from '../../src/core/keys';
import { parseTsc } from '../../src/ui/format';

const PASSWORD = 'regtest-selection-only-password-2026';
interface CoreTransaction {
  txid: string; confirmations?: number; vsize: number;
  vin: { txid: string; vout: number }[];
  vout: { n: number; value: number; scriptPubKey: { address?: string } }[];
}
interface CoreOutput { value: number; confirmations: number; }
interface FundingOutput { txid: string; vout: number; amountUnits: string; }
const atomic = (value: number): string => parseTsc(value.toFixed(8));

async function restore(page: Page, phrase: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Restore a wallet', exact: true }).click();
  await page.locator('textarea[name=mnemonic]').fill(phrase);
  await page.locator('input[name=password]').fill(PASSWORD);
  await page.locator('input[name=confirmPassword]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Restore wallet', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Keep it simple.' })).toBeVisible();
  await expect(page.getByTestId('wallet-sync')).toHaveAttribute('data-sync-state', 'idle', { timeout: 60000 });
}
async function confirmPayment(page: Page, recipient: string, amount: string): Promise<string> {
  await page.getByLabel('Recipient address').fill(recipient);
  await page.getByLabel('Amount · TSC', { exact: true }).fill(amount);
  await page.getByLabel('Network fee rate · atomic units/vbyte').fill('1');
  await page.getByRole('button', { name: /^Review transfer/ }).click();
  await expect(page.getByRole('heading', { name: 'Check every detail.' })).toBeVisible();
  await expect(page.locator('.review-list > div').filter({ has: page.locator('dt', { hasText: /^Funds used$/ }) }).locator('dd')).toHaveText('1 UTXO');
  await expect(page.locator('.review-list > div').filter({ has: page.locator('dt', { hasText: /^Network fee$/ }) }).locator('dd')).toHaveText('0.00000141 TSC');
  await page.getByRole('button', { name: 'Confirm & send', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'On its way.' })).toBeVisible({ timeout: 60000 });
  const txid = (await page.locator('.review-list dd.mono').innerText()).trim();
  expect(/^[a-f0-9]{64}$/.test(txid)).toBe(true); return txid;
}
function feeUnits(input: FundingOutput, transaction: CoreTransaction): string {
  return String(BigInt(input.amountUnits) - transaction.vout.reduce((total, output) => total + BigInt(atomic(output.value)), 0n));
}

test('real TensorCash Core: smallest sufficient output leaves a confirmed output for another payment before change confirms', async ({ page, browserName }) => {
  test.setTimeout(180000);
  await assertIsolatedRegtest();
  const fixture = await prepareRegtestFixture();
  // Fresh test-only entropy isolates every browser and repeated run from prior
  // confirmed change. Restoring it avoids the unrelated backup challenge UI.
  const phrase = newMnemonic();
  const account = deriveAccount(phrase, 'regtest');
  let address: string;
  try { address = deriveAddress(account, 'regtest', 0, 0).address; }
  finally { account.wipePrivateData(); }
  const outgoing: string[] = [];
  page.on('request', request => { const body = request.postData(); if (body) outgoing.push(body); });
  const funding: FundingOutput[] = [];
  for (const amount of [0.02699577, 0.004, 0.0005]) {
    const txid = await regtestRpc<string>('sendtoaddress', { address, amount, fee_rate: 2 }, 'wallet-web-miner');
    const transaction = await regtestRpc<CoreTransaction>('getrawtransaction', [txid, true]);
    const output = transaction.vout.find(item => item.scriptPubKey.address === address && atomic(item.value) === atomic(amount));
    expect(!!output).toBe(true);
    funding.push({ txid, vout: output!.n, amountUnits: atomic(amount) });
  }
  await regtestRpc('generatetoaddress', [2, fixture.minerAddress]);
  for (const output of funding) {
    const coin = await regtestRpc<CoreOutput | null>('gettxout', [output.txid, output.vout, true]);
    expect(coin?.confirmations).toBeGreaterThanOrEqual(2);
  }
  await restore(page, phrase);
  await expect(page.getByTestId('balance-total')).toHaveText('0.03149577TSC');
  await expect(page.getByTestId('balance-available')).toHaveText('0.03149577 TSC');
  const heightBeforePayments = await regtestRpc<number>('getblockcount');
  await page.getByRole('navigation', { name: 'Wallet sections' }).getByRole('button', { name: 'Send', exact: true }).click();
  const firstTxid = await confirmPayment(page, fixture.recipient, '0.001');
  const first = await regtestRpc<CoreTransaction>('getrawtransaction', [firstTxid, true]);
  expect(first.vin).toHaveLength(1); expect(first.vin[0]).toMatchObject({ txid: funding[1].txid, vout: funding[1].vout });
  expect(first.vout.some(output => output.scriptPubKey.address === fixture.recipient && atomic(output.value) === '100000')).toBe(true);
  expect(feeUnits(funding[1], first)).toBe('141');
  await regtestRpc('getmempoolentry', [firstTxid]);
  expect(first.confirmations ?? 0).toBe(0);
  expect(await regtestRpc('gettxout', [funding[1].txid, funding[1].vout, true])).toBeNull();
  expect((await regtestRpc<CoreOutput>('gettxout', [funding[0].txid, funding[0].vout, true])).confirmations).toBeGreaterThanOrEqual(2);
  expect((await regtestRpc<CoreOutput>('gettxout', [funding[2].txid, funding[2].vout, true])).confirmations).toBeGreaterThanOrEqual(2);

  // The receipt must recover send readiness from the retained confirmed coins.
  // Do not mine between payments: the first change remains pending throughout.
  await expect(page.getByRole('button', { name: 'Send another', exact: true })).toBeEnabled({ timeout: 60000 });
  await expect(page.locator('.receipt-next')).toContainText('0.02749577 TSC');
  expect(await regtestRpc<number>('getblockcount')).toBe(heightBeforePayments);
  await regtestRpc('getmempoolentry', [firstTxid]);
  await page.getByRole('button', { name: 'Send another', exact: true }).click();
  const secondTxid = await confirmPayment(page, fixture.recipient, '0.002');
  const second = await regtestRpc<CoreTransaction>('getrawtransaction', [secondTxid, true]);
  expect(second.vin).toHaveLength(1); expect(second.vin[0]).toMatchObject({ txid: funding[0].txid, vout: funding[0].vout });
  expect(second.vout.some(output => output.scriptPubKey.address === fixture.recipient && atomic(output.value) === '200000')).toBe(true);
  expect(feeUnits(funding[0], second)).toBe('141');
  await regtestRpc('getmempoolentry', [secondTxid]); await regtestRpc('getmempoolentry', [firstTxid]);
  expect(second.confirmations ?? 0).toBe(0); expect(await regtestRpc<number>('getblockcount')).toBe(heightBeforePayments);
  const firstChange = first.vout.find(output => output.scriptPubKey.address !== fixture.recipient)!;
  expect(atomic(firstChange.value)).toBe('299859');
  expect((await regtestRpc<CoreOutput>('gettxout', [firstTxid, firstChange.n, true])).confirmations).toBe(0);
  expect((await regtestRpc<CoreOutput>('gettxout', [funding[2].txid, funding[2].vout, true])).confirmations).toBeGreaterThanOrEqual(2);
  expect(outgoing.some(body => body.includes(phrase) || body.includes(PASSWORD))).toBe(false);
  const watch = await regtestRpc<{ private_keys_enabled: boolean }>('getwalletinfo', [], 'wallet-web-watch');
  expect(watch.private_keys_enabled).toBe(false);
  await mkdir('artifacts/evidence/polish', { recursive: true });
  await writeFile(`artifacts/evidence/polish/coin-selection-${browserName}.json`, JSON.stringify({
    generatedAt: new Date().toISOString(), browser: browserName, network: 'isolated-regtest',
    funding, requiredConfirmations: 2, feeRate: '1',
    firstTxid, firstSelectedAmountUnits: funding[1].amountUnits, firstInputCount: first.vin.length,
    firstAmountUnits: '100000', firstFeeUnits: feeUnits(funding[1], first), firstChangeUnits: atomic(firstChange.value),
    secondTxid, secondSelectedAmountUnits: funding[0].amountUnits, secondInputCount: second.vin.length,
    secondAmountUnits: '200000', secondFeeUnits: feeUnits(funding[0], second),
    smallestSufficientSingleOutputSelected: true, firstChangeStillUnconfirmedDuringSecondSend: true,
    secondPaymentAcceptedWithoutMiningFirst: true, smallestConfirmedOutputPreserved: true,
    noSecretsInNetworkRequests: true, watchOnlyGateway: true,
  }, null, 2) + '\n');
});
