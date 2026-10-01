import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const REGTEST_GENESIS = 'cf63c021e5a8ea0bc04cf7b12ab12e0a7902ef2dae5bdd8cbb3a0d41c3345da4';
export const REGTEST_COOKIE = resolve(process.cwd(), process.env.WALLET_REGTEST_COOKIE || '.runtime/regtest/regtest/.cookie');
export async function regtestRpc<T = unknown>(method: string, params: unknown[] | Record<string, unknown> = [], wallet?: string): Promise<T> {
  const cookie = (await readFile(REGTEST_COOKIE, 'utf8')).trim();
  const response = await fetch(`http://127.0.0.1:19453/${wallet ? `wallet/${encodeURIComponent(wallet)}` : ''}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(cookie).toString('base64')}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'wallet-regtest-only', method, params }), signal: AbortSignal.timeout(60000),
  });
  const data = await response.json() as { result: T; error?: { code: number; message: string } };
  if (data.error) throw new Error(`Regtest RPC ${method}: ${data.error.code} ${data.error.message}`);
  return data.result;
}
export async function assertIsolatedRegtest(): Promise<void> {
  const info = await regtestRpc<{ chain: string }>('getblockchaininfo');
  const genesis = await regtestRpc<string>('getblockhash', [0]);
  if (info.chain !== 'regtest' || genesis !== REGTEST_GENESIS) throw new Error('Refusing to send on a non-regtest chain.');
}
export async function prepareRegtestFixture(): Promise<{ minerAddress: string; recipient: string }> {
  await assertIsolatedRegtest();
  for (const name of ['wallet-web-miner', 'wallet-web-recipient']) {
    try { await regtestRpc('createwallet', [name]); }
    catch (error) { if (!(error instanceof Error) || !/-4|-35/.test(error.message)) throw error; }
  }
  const minerAddress = await regtestRpc<string>('getnewaddress', ['', 'bech32'], 'wallet-web-miner');
  const recipient = await regtestRpc<string>('getnewaddress', ['', 'bech32'], 'wallet-web-recipient');
  const count = await regtestRpc<number>('getblockcount');
  if (count < 103) await regtestRpc('generatetoaddress', [103 - count, minerAddress]);
  return { minerAddress, recipient };
}
