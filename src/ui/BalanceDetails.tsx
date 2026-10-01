import { useState } from 'react';
import type { AddressRecord, WalletSnapshot } from '../shared/types';
import { formatTsc, safeExplorerLink, utxoStatus } from './format';

const PAGE_SIZE = 20;
const order = { available: 0, pending: 1, unverified: 2 };

export function BalanceDetails({ snapshot, ownedAddresses, cached, stale }: {
  snapshot: WalletSnapshot; ownedAddresses: AddressRecord[]; cached: boolean; stale: boolean;
}) {
  const [visible, setVisible] = useState(PAGE_SIZE);
  const addresses = new Map(ownedAddresses.map(record => [record.address, record]));
  const coins = snapshot.utxos.map(coin => ({ coin, status: utxoStatus(coin, snapshot.network) }))
    .sort((a, b) => order[a.status] - order[b.status] || (BigInt(a.coin.amountUnits) > BigInt(b.coin.amountUnits) ? -1 : BigInt(a.coin.amountUnits) < BigInt(b.coin.amountUnits) ? 1 : `${a.coin.txid}:${a.coin.vout}`.localeCompare(`${b.coin.txid}:${b.coin.vout}`)));
  const available = coins.filter(item => item.status === 'available').length;
  const pending = coins.filter(item => item.status === 'pending').length;
  const unverified = coins.length - available - pending;
  return <details className="balance-breakdown" data-testid="balance-breakdown">
    <summary><span>Balance details</span>{!cached && <span className="output-count">{available} available · {pending} pending{unverified ? ` · ${unverified} unverified` : ''}</span>}</summary>
    {cached ? <p className="utxo-help">Output details will appear after a fresh wallet sync.</p> : <>
      {stale && <p className="utxo-help">Last verified outputs. Sending resumes after a fresh wallet sync.</p>}
      <p className="utxo-help">Each UTXO is a separate part of your balance. Available UTXOs are selected and combined automatically when you send. Pending funds need {snapshot.network.minConfirmations} confirmations before you can spend them.</p>
      {!coins.length ? <p className="utxo-help">No unspent outputs.</p> : <ul className="utxo-list" aria-label="Wallet UTXOs">
        {coins.slice(0, visible).map(({ coin, status }) => {
          const record = addresses.get(coin.address);
          const link = safeExplorerLink(snapshot.network.explorerUrl, coin.txid);
          const required = coin.coinbase ? Math.max(snapshot.network.minConfirmations, snapshot.network.coinbaseMaturity) : snapshot.network.minConfirmations;
          const label = status === 'available' ? 'Available' : status === 'unverified' ? 'Unverified' : coin.coinbase ? 'Maturing' : 'Pending';
          return <li key={`${coin.txid}:${coin.vout}`} className="utxo-row" data-outpoint={`${coin.txid}:${coin.vout}`} data-status={status}>
            <div className="utxo-heading"><strong>{formatTsc(coin.amountUnits)} <span>TSC</span></strong><span className={`utxo-status ${status}`}>{label}</span></div>
            <div className="utxo-meta"><span>{coin.coinbase ? 'Mining reward' : record?.branch === 1 ? 'Change from a payment' : 'Received funds'}</span><span>{coin.confirmations.toLocaleString()} / {required} confirmations</span></div>
            <dl className="utxo-identifiers"><div><dt>Address</dt><dd className="mono">{coin.address}</dd></div><div><dt>Transaction · output {coin.vout}</dt><dd className="mono">{link ? <a href={link} target="_blank" rel="noopener noreferrer">{coin.txid} ↗</a> : coin.txid}</dd></div></dl>
            {status === 'unverified' && <p className="utxo-help">Excluded from the native TSC balance and payments.</p>}
          </li>;
        })}
      </ul>}
      {visible < coins.length && <button className="button text utxo-more" type="button" onClick={() => setVisible(count => count + PAGE_SIZE)}>Show {Math.min(PAGE_SIZE, coins.length - visible)} more · {coins.length - visible} remaining</button>}
    </>}
  </details>;
}
