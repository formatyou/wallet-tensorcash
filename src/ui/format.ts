import type { HistoryEntry, NetworkInfo, Utxo, WalletNetwork, WalletSnapshot } from '../shared/types';

export const UNIT = 100_000_000n;
export function formatTsc(value: string | bigint): string {
  const units = BigInt(value);
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const fraction = (absolute % UNIT).toString().padStart(8, '0').replace(/0+$/, '');
  return `${negative ? '−' : ''}${absolute / UNIT}${fraction ? `.${fraction}` : ''}`;
}
export function parseTsc(value: string): string {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,8})?$/.test(normalized)) throw new Error('Enter a TSC amount with up to eight decimal places.');
  const [whole, fraction = ''] = normalized.split('.');
  const amount = BigInt(whole) * UNIT + BigInt(fraction.padEnd(8, '0'));
  if (amount <= 0n) throw new Error('The amount must be greater than zero.');
  return amount.toString();
}
export function eligibleUtxos(snapshot: WalletSnapshot): Utxo[] {
  return snapshot.utxos.filter(utxo => utxoStatus(utxo, snapshot.network) === 'available');
}
function isVerifiedNative(utxo: Utxo): boolean {
  return utxo.verified && utxo.classification === 'native' && typeof utxo.rawParent === 'string' && utxo.rawParent.length > 0;
}
export function utxoStatus(utxo: Utxo, network: Pick<NetworkInfo, 'minConfirmations' | 'coinbaseMaturity'>): 'available' | 'pending' | 'unverified' {
  if (!isVerifiedNative(utxo)) return 'unverified';
  const required = utxo.coinbase ? Math.max(network.minConfirmations, network.coinbaseMaturity) : network.minConfirmations;
  return utxo.confirmations >= required ? 'available' : 'pending';
}
export function walletBalances(snapshot: WalletSnapshot) {
  const sum = (utxos: Utxo[]) => utxos.reduce((value, utxo) => value + BigInt(utxo.amountUnits), 0n);
  return {
    spendable: snapshot.complete && snapshot.network.ready ? sum(eligibleUtxos(snapshot)) : 0n,
    pending: sum(snapshot.utxos.filter(utxo => utxoStatus(utxo, snapshot.network) === 'pending')),
    unsupported: sum(snapshot.utxos.filter(utxo => utxoStatus(utxo, snapshot.network) === 'unverified')),
  };
}
export function receiveCursorKey(walletId: string): string { return `tensorcash.receive-index.${walletId}`; }
export function readReceiveCursor(walletId: string): number {
  try {
    const value = localStorage.getItem(receiveCursorKey(walletId));
    if (value === null) return 0;
    const index = Number(value);
    return Number.isSafeInteger(index) && index >= 0 && index <= 100_000 ? index : 0;
  } catch { return 0; }
}
export function rememberReceiveCursor(walletId: string, index: number): void {
  localStorage.setItem(receiveCursorKey(walletId), String(index));
}
export const KNOWN_NETWORK_KEY = 'tensorcash.network';
export function readKnownNetwork(): WalletNetwork | null {
  try {
    const value = localStorage.getItem(KNOWN_NETWORK_KEY);
    return value === 'mainnet' || value === 'regtest' ? value : null;
  } catch { return null; }
}
export function rememberKnownNetwork(network: WalletNetwork): void {
  try { if (localStorage.getItem(KNOWN_NETWORK_KEY) !== network) localStorage.setItem(KNOWN_NETWORK_KEY, network); }
  catch { /* Remembering the network is optional; onboarding then waits for the gateway. */ }
}
export function safeExplorerLink(explorerUrl: string | null, txid: string): string | null {
  if (!explorerUrl || !/^[a-f0-9]{64}$/i.test(txid)) return null;
  try {
    const url = new URL(explorerUrl);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) return null;
    return `${url.origin}${url.pathname.replace(/\/$/, '')}/tx/${txid}`;
  } catch { return null; }
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The operation could not be completed. Please try again.';
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'unavailable';
  if (seconds < 60) return `${Math.ceil(seconds)} sec`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} min`;
  const minutes = Math.ceil(seconds / 60);
  return `${Math.floor(minutes / 60)} hr${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
}
export function formatUpdatedAt(timestamp: string, now = new Date()): string {
  const updated = new Date(timestamp);
  const time = updated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (updated.toDateString() === now.toDateString()) return time;
  const date = updated.toLocaleDateString([], { month: 'short', day: 'numeric', ...(updated.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
  return `${date} · ${time}`;
}
export function confirmationView(entry: HistoryEntry, network: NetworkInfo) {
  const target = Math.max(1, network.minConfirmations);
  const confirmed = entry.status !== 'conflicted' && entry.confirmations >= target;
  const average = network.averageBlockSeconds;
  const estimate = entry.status !== 'conflicted' && !confirmed && network.network !== 'regtest' &&
    typeof average === 'number' && Number.isFinite(average) && average > 0
    ? `approx. ${formatDuration((target - entry.confirmations) * average)}` : null;
  return {
    confirmed,
    progress: `${Math.min(entry.confirmations, target)}/${target}`,
    label: entry.status === 'conflicted' ? 'Conflicted' : confirmed ? 'Confirmed' : 'Pending',
    estimate,
  };
}
