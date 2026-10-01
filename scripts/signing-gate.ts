import { mkdir, writeFile } from 'node:fs/promises';
import { deriveAccount, deriveAddress, createMetadata, newMnemonic } from '../src/core/keys';
import { prepareNativeTransfer, signNativeTransfer, decodeNativeTransaction } from '../src/core/transactions';
import { regtestRpc, assertIsolatedRegtest, prepareRegtestFixture, REGTEST_GENESIS } from './regtest-rpc';
import type { Utxo } from '../src/shared/types';

await assertIsolatedRegtest();
const { minerAddress, recipient } = await prepareRegtestFixture();
const mnemonic = newMnemonic();
const account = deriveAccount(mnemonic, 'regtest');
try {
  const metadata = createMetadata(account, 'regtest', true);
  const receive = deriveAddress(account, 'regtest', 0, 0);
  const change = deriveAddress(account, 'regtest', 1, 0);
  const funded = [];
  for (let i = 0; i < 2; i++) {
    await assertIsolatedRegtest();
    funded.push(await regtestRpc<string>('sendtoaddress', { address: receive.address, amount: 1, fee_rate: 2 }, 'wallet-web-miner'));
  }
  await regtestRpc('generatetoaddress', [3, minerAddress]);
  const utxos: Utxo[] = [];
  for (const txid of funded) {
    const { hex: raw } = await regtestRpc<{ hex: string }>('gettransaction', [txid], 'wallet-web-miner');
    const decoded = decodeNativeTransaction(raw);
    if (decoded.txid !== txid) throw new Error('Client transaction hash differs from Core.');
    const output = decoded.outputs.find(o => o.scriptHex === receive.scriptHex);
    if (!output) throw new Error('Fixture did not fund the client address.');
    const previous = await regtestRpc<{ confirmations: number }>('gettxout', [txid, output.vout, true]);
    utxos.push({ txid, vout: output.vout, address: receive.address, scriptHex: receive.scriptHex,
      amountUnits: output.amountUnits, confirmations: previous.confirmations, blockHeight: null,
      coinbase: false, classification: 'native', rawParent: raw, verified: true });
  }
  const prepared = prepareNativeTransfer({ network: 'regtest', recipient, amountUnits: '150000000', feeRate: '2',
    utxos, ownedAddresses: [receive, change], change }, account, metadata);
  const psbt = await regtestRpc<{ tx: { txid: string }; fee: number }>('decodepsbt', [Buffer.from(prepared.psbtHex, 'hex').toString('base64')]);
  if (Math.round(psbt.fee * 100000000) !== Number(prepared.plan.feeUnits)) throw new Error('PSBT fee differs in Core.');
  const signed = signNativeTransfer(prepared, account);
  const core = await regtestRpc<{ txid: string; hash: string; vsize: number; asset_summary: { has_assets: boolean; has_icu: boolean } }>('decodeassettransaction', [signed.rawHex, false]);
  const local = decodeNativeTransaction(signed.rawHex);
  if (core.txid !== signed.txid || core.hash !== local.wtxid || core.vsize !== signed.vsize || core.asset_summary.has_assets || core.asset_summary.has_icu)
    throw new Error('Client and Core transaction decode disagree.');
  const accept = await regtestRpc<{ allowed: boolean; 'reject-reason'?: string }[]>('testmempoolaccept', [[signed.rawHex]]);
  if (!accept[0].allowed) throw new Error(`Local signature was rejected: ${accept[0]['reject-reason']}`);
  await assertIsolatedRegtest();
  const txid = await regtestRpc<string>('sendrawtransaction', [signed.rawHex]);
  if (txid !== signed.txid) throw new Error('Broadcast returned another transaction.');
  await regtestRpc('generatetoaddress', [1, minerAddress]);
  const received = await regtestRpc<{ confirmations: number }>('gettransaction', [txid], 'wallet-web-recipient');
  if (received.confirmations < 1) throw new Error('Transfer did not confirm.');
  const report = { generatedAt: new Date().toISOString(), status: 'passed', network: 'regtest',
    genesis: REGTEST_GENESIS, coreImage: 'tensorcash-local/core:v1.2.2',
    signer: '@scure/btc-signer@2.4.1', derivation: metadata.accountPath,
    txid, inputCount: prepared.plan.inputCount, feeUnits: signed.feeUnits, vsize: signed.vsize,
    confirmations: received.confirmations, checks: ['client parent txid parity', 'PSBT v0 Core decode', 'wtxid and vsize parity', 'native asset classification', 'local ECDSA accepted by Core', 'isolated regtest broadcast and confirmation'] };
  await mkdir('artifacts/evidence', { recursive: true });
  await writeFile('artifacts/evidence/signing-gate.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { account.wipePrivateData(); }
