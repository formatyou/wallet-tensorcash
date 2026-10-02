import { cloneElement, isValidElement, useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import QRCode from 'qrcode';
import { BalanceDetails } from './ui/BalanceDetails';
import { Toast } from './ui/Toast';
import { WalletEngineClient } from './wallet/client';
import type { WalletDisplayCache } from './wallet/display-cache';
import { quoteNativeSendMax } from './core/fees';
import { createProvider, NetworkReadinessError } from './provider/client';
import { networkRetryDelay, WalletRecovery } from './provider/recovery';
import { discoverWallet, refreshKnownWallet, type DiscoveredWallet } from './provider/discovery';
import { isPendingTransferReconciled, reconcilePendingTransfers } from './wallet/reconciliation';
import type { AddressRecord, FeePolicy, HistoryEntry, NetworkInfo, SignedTransfer, TransferPlan, WalletMetadata, WalletSnapshot } from './shared/types';
import { confirmationView, eligibleUtxos, errorMessage, formatDuration, formatTsc, formatUpdatedAt, parseTsc, readReceiveCursor, receiveCursorKey, rememberReceiveCursor, safeExplorerLink, walletBalances } from './ui/format';
import { acceptedTransfersKey, clearJournal, hasJournal, loadAcceptedTransfers, loadJournal, markBroadcastAttempted, rememberAcceptedTransfer, retainAcceptedTransfers, saveJournal } from './ui/broadcast-journal';

type Tab = 'overview' | 'receive' | 'send' | 'settings';
type SeedView = { mnemonic: string; purpose: 'create' | 'reveal' };
type Receipt = Pick<SignedTransfer, 'txid' | 'feeUnits' | 'vsize'>;
const CHALLENGE = [2, 5, 9];
const INACTIVITY_MS = 5 * 60 * 1000;
const SOURCE_URL = 'https://github.com/formatyou/wallet-tensorcash';
class ConnectionError extends Error {
  constructor(message: string, readonly cause: unknown) { super(message); }
}

function Icon({ name, size = 20 }: { name: 'arrow-up' | 'arrow-down' | 'lock' | 'refresh' | 'check' | 'copy' | 'settings' | 'wallet'; size?: number }) {
  const paths: Record<string, ReactNode> = {
    'arrow-up': <><path d="M12 19V5m-6 6 6-6 6 6" /></>,
    'arrow-down': <><path d="M12 5v14m-6-6 6 6 6-6" /></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2" /></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    copy: <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M16 8V3H3v13h5" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="m9 3-1 3-3 1-2 3 2 2v3l3 2 1 4h6l1-4 3-2v-3l2-2-2-3-3-1-1-3Z" /></>,
    wallet: <><rect x="3" y="5" width="18" height="15" rx="2" /><path d="M3 8h18m0 5h-6v4h6" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
function Field({ label, children, hint, action }: { label: string; children: ReactNode; hint?: string; action?: ReactNode }) {
  const id = useId();
  const input = isValidElement<{ id?: string; 'aria-describedby'?: string }>(children)
    ? cloneElement(children, { id, 'aria-describedby': [children.props['aria-describedby'], hint ? `${id}-hint` : undefined].filter(Boolean).join(' ') || undefined }) : children;
  return <div className="field"><label htmlFor={id}>{label}</label>{action ? <div className="input-with-action">{input}{action}</div> : input}{hint && <small id={`${id}-hint`}>{hint}</small>}</div>;
}
function PasswordField({ name = 'password', label = 'Wallet password', confirm = false }: { name?: string; label?: string; confirm?: boolean }) {
  return <Field label={label} hint={confirm ? 'Use at least 12 characters. This password encrypts this device’s wallet.' : undefined}>
    <input name={name} type="password" autoComplete={confirm ? 'new-password' : 'current-password'} minLength={confirm ? 12 : undefined} maxLength={256} required />
  </Field>;
}
function GitHubMark() {
  return <svg className="gh-mark" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59 0.4 0.07 0.55-0.17 0.55-0.38 0-0.19-0.01-0.82-0.01-1.49-2.01 0.37-2.53-0.49-2.69-0.94-0.09-0.23-0.48-0.94-0.82-1.13-0.28-0.15-0.68-0.52-0.01-0.53 0.63-0.01 1.08 0.58 1.23 0.82 0.72 1.21 1.87 0.87 2.33 0.66 0.07-0.52 0.28-0.87 0.51-1.07-1.78-0.2-3.64-0.89-3.64-3.95 0-0.87 0.31-1.59 0.82-2.15-0.08-0.2-0.36-1.02 0.08-2.12 0 0 0.67-0.21 2.2 0.82 0.64-0.18 1.32-0.27 2-0.27 0.68 0 1.36 0.09 2 0.27 1.53-1.04 2.2-0.82 2.2-0.82 0.44 1.1 0.16 1.92 0.08 2.12 0.51 0.56 0.82 1.27 0.82 2.15 0 3.07-1.87 3.75-3.65 3.95 0.29 0.25 0.54 0.73 0.54 1.48 0 1.07-0.01 1.93-0.01 2.2 0 0.21 0.15 0.46 0.55 0.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" /></svg>;
}
// Decorative: the device boundary keeps the phrase and key inside; only the signed transaction leaves, via the gateway, into a block.
function LandingDiagram() {
  const words = Array.from({ length: 12 }, (_, index) => <rect key={index} className="ld-word" x={36 + (index % 3) * 40} y={78 + Math.floor(index / 3) * 18} width="30" height="8" rx="4" />);
  return <div className="how-figure"><svg className="landing-diagram" viewBox="0 30 1000 168" aria-hidden="true" focusable="false">
    <path className="ld-ink" d="M373 100V52a12 12 0 0 0-12-12H13A12 12 0 0 0 1 52v116a12 12 0 0 0 12 12h348a12 12 0 0 0 12-12v-48" />
    <g className="ld-lock"><rect x="24" y="34" width="16" height="13" rx="2" /><path d="M27 34v-3a5 5 0 0 1 10 0v3" /></g>
    {words}
    <path className="ld-faint ld-dash" d="M152 110h20" />
    <g className="ld-key"><circle cx="194" cy="110" r="16" /><circle cx="194" cy="110" r="5" /><path d="M210 110h52M248 110v10M257 110v7" /></g>
    <rect className="ld-ink ld-fill" x="286" y="70" width="58" height="80" rx="3" />
    <path className="ld-faint" d="M297 87h36M297 97h28M297 107h32" />
    <path className="ld-sign" d="M297 133c5-9 9 4 14-2s7-7 11 0 6 2 11-4" />
    <path className="ld-ink" d="M344 110h156M580 110h120" />
    <rect className="ld-packet" x="400" y="105" width="10" height="10" transform="rotate(45 405 110)" />
    <rect className="ld-ink ld-fill" x="500" y="78" width="80" height="64" rx="4" />
    <path className="ld-faint" d="M500 99.5h80M500 120.5h80" />
    <path className="ld-check" d="M510 109l3 3 6-6" /><circle className="ld-dot" cx="514" cy="89" r="2" /><circle className="ld-dot" cx="514" cy="131" r="2" />
    <path className="ld-faint" d="M530 89h38M530 110h30M530 131h38" />
    <rect className="ld-pending" x="700" y="88" width="44" height="44" rx="2" />
    <rect className="ld-packet" x="717" y="105" width="10" height="10" transform="rotate(45 722 110)" />
    {[0, 1, 2, 3].map(index => <g key={index}><path className="ld-ink" d={`M${744 + index * 64} 110h20`} /><rect className="ld-ink ld-fill" x={764 + index * 64} y="88" width="44" height="44" rx="2" /><path className="ld-faint" d={`M${774 + index * 64} 102h24M${774 + index * 64} 110h18M${774 + index * 64} 118h22`} /></g>)}
    <path className="ld-rule" d="M0 196h1000M0.5 190v6M400 190v6M680 190v6M999.5 190v6" />
  </svg></div>;
}
function NetworkBadge({ network }: { network: NetworkInfo | null }) {
  return <span className={`network-badge ${network?.network === 'regtest' ? 'test-network' : ''} ${!network?.ready ? 'network-waiting' : ''}`} title={network ? network.network === 'regtest' ? 'Regtest · test coins' : 'TensorCash mainnet' : undefined}><span className="status-dot" />{network ? network.network === 'regtest' ? 'Regtest' : 'Mainnet' : 'Connecting'}</span>;
}
function NetworkDetails({ network }: { network: NetworkInfo }) {
  const average = network.averageBlockSeconds;
  const hasTiming = network.network !== 'regtest' && typeof average === 'number' && Number.isFinite(average) && average > 0;
  return <details className="network-details"><summary>Network details</summary><dl>
    <div><dt>Confirmations to spend</dt><dd>{network.minConfirmations}</dd></div>
    {hasTiming && <div data-testid="block-timing"><dt>Average block</dt><dd>approx. {formatDuration(average)}{network.blockTimeSampleSize ? <small>Last {network.blockTimeSampleSize} blocks</small> : null}</dd></div>}
    <div><dt>Latest block</dt><dd>{network.height.toLocaleString()}{network.lastBlockTime ? <small>{new Date(network.lastBlockTime * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small> : null}</dd></div>
  </dl></details>;
}
function NetworkUpdate({ network, hasWallet, unlocked, hasBalance }: { network: NetworkInfo; hasWallet: boolean; unlocked: boolean; hasBalance: boolean }) {
  const [takingLonger, setTakingLonger] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setTakingLonger(true), 30_000);
    return () => clearTimeout(timer);
  }, []);
  const unavailable = network.readinessReason === 'index-unavailable' || network.readinessReason === 'stale-data';
  const title = takingLonger ? 'Wallet data is taking longer to update' : unavailable ? 'Waiting for wallet data' : 'Updating wallet data';
  return <div className="callout network-update" role="status"><Icon name="refresh" size={16} /><div><strong>{title}</strong><p>{unlocked
    ? hasBalance ? 'Last verified balance shown. Checking for updates.' : 'Checking your balance automatically.'
    : hasWallet ? 'You can unlock while we refresh.' : 'Checking the network automatically.'}</p></div></div>;
}
function ActivityRow({ entry, network }: { entry: HistoryEntry; network: NetworkInfo }) {
  const incoming = BigInt(entry.deltaUnits) >= 0n;
  const confirmation = confirmationView(entry, network);
  const link = safeExplorerLink(network.explorerUrl, entry.txid);
  const action = entry.status === 'conflicted' ? 'Conflicted transfer' : incoming ? confirmation.confirmed ? 'Received' : 'Receiving' : confirmation.confirmed ? 'Sent' : 'Sending';
  return <article className="history-row" data-txid={entry.txid}><span className={`transaction-icon ${incoming ? 'incoming' : ''}`}><Icon name={incoming ? 'arrow-down' : 'arrow-up'} /></span><div className="transaction-description"><strong>{action}</strong><span>{entry.timestamp ? new Date(entry.timestamp * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Awaiting block'}</span>{link ? <a className="tx-link mono" href={link} target="_blank" rel="noopener noreferrer">{entry.txid.slice(0, 10)}…{entry.txid.slice(-6)} ↗</a> : <span className="tx-link mono">{entry.txid.slice(0, 10)}…{entry.txid.slice(-6)}</span>}</div><div className="transaction-value"><strong>{incoming ? '+' : ''}{formatTsc(entry.deltaUnits)} <span>TSC</span></strong><span className={`tx-status ${entry.status === 'conflicted' ? 'conflicted' : confirmation.confirmed ? 'confirmed' : 'pending'}`} title={`${entry.confirmations} confirmations; ${network.minConfirmations} required`}>{entry.status === 'conflicted' ? 'Conflicted' : `${confirmation.label} · ${confirmation.progress}`}</span>{confirmation.estimate && <span className="confirmation-estimate" title="Estimated from recent blocks. Network conditions can change the wait.">{confirmation.estimate}</span>}</div></article>;
}
function submitData(event: FormEvent<HTMLFormElement>): { data: FormData; form: HTMLFormElement } {
  event.preventDefault();
  return { data: new FormData(event.currentTarget), form: event.currentTarget };
}
function requiredText(data: FormData, key: string): string { return String(data.get(key) ?? ''); }
function validateNewPassword(data: FormData, key = 'password'): string {
  const password = requiredText(data, key);
  if (password.length < 12) throw new Error('Use a password with at least 12 characters.');
  if (password !== requiredText(data, 'confirmPassword')) throw new Error('The passwords do not match.');
  return password;
}
function ceilRate(value: string): string {
  if (!/^\d+(?:\.\d+)?$/.test(value)) throw new Error('The provider returned an invalid fee rate.');
  const [whole, fractional] = value.split('.');
  return (BigInt(whole) + (fractional && /[1-9]/.test(fractional) ? 1n : 0n)).toString();
}

export default function App() {
  const engine = useRef<WalletEngineClient | null>(null);
  if (!engine.current) engine.current = new WalletEngineClient();
  const wallet = engine.current;
  const provider = useRef(createProvider()).current;
  const [metadata, setMetadata] = useState<WalletMetadata | null>(null);
  const [network, setNetwork] = useState<NetworkInfo | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [welcomeMode, setWelcomeMode] = useState<'start' | 'create' | 'restore'>('start');
  const [restoreError, setRestoreError] = useState('');
  const restoreErrorRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (restoreError) restoreErrorRef.current?.focus(); }, [restoreError]);
  const [restoreMode, setRestoreMode] = useState<'seed' | 'file'>('seed');
  const [encryptedImport, setEncryptedImport] = useState('');
  const [seed, setSeed] = useState<SeedView | null>(null);
  const [seedObscured, setSeedObscured] = useState(false);
  const [confirmSeed, setConfirmSeed] = useState(false);
  const [tab, setTab] = useState<Tab>('overview');
  const [snapshot, setSnapshot] = useState<WalletSnapshot | null>(null);
  const [cachedDisplay, setCachedDisplay] = useState<WalletDisplayCache | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState('');
  const [syncTrusted, setSyncTrusted] = useState(false);
  const [awaitingReconciliation, setAwaitingReconciliation] = useState(false);
  const [receive, setReceive] = useState<AddressRecord | null>(null);
  const [change, setChange] = useState<AddressRecord | null>(null);
  const [ownedAddresses, setOwnedAddresses] = useState<AddressRecord[]>([]);
  const [fees, setFees] = useState<FeePolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [networkWaiting, setNetworkWaiting] = useState<NetworkInfo | null>(null);
  const [checkingConnection, setCheckingConnection] = useState(false);
  const [notice, setNotice] = useState('');
  const [qr, setQr] = useState('');
  const [plan, setPlan] = useState<TransferPlan | null>(null);
  const [signed, setSigned] = useState<SignedTransfer | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [retryRequired, setRetryRequired] = useState(false);
  const [journalBlocked, setJournalBlocked] = useState(false);
  const [discardAllowed, setDiscardAllowed] = useState(false);
  const [sendMax, setSendMax] = useState(false);
  const [sendAmount, setSendAmount] = useState('');
  const [sendRecipient, setSendRecipient] = useState('');
  const [feeRate, setFeeRate] = useState('');
  const [settingsMode, setSettingsMode] = useState<'menu' | 'export' | 'reveal' | 'password' | 'reset'>('menu');
  const sessionEpoch = useRef(0);
  const busyRef = useRef(false);
  const lastActivity = useRef(Date.now());
  const alive = useRef(true);
  const connectionInFlight = useRef<Promise<NetworkInfo> | null>(null);
  const connectionReady = useRef(false);
  const unavailableAttempts = useRef(0);
  const walletRecovery = useRef(new WalletRecovery()).current;
  const rescheduleConnection = useRef<(() => void) | null>(null);
  const syncInFlight = useRef<{ epoch: number; token: symbol; promise: Promise<void> } | null>(null);
  const knownWallet = useRef<DiscoveredWallet | null>(null);
  const syncGeneration = useRef(0);
  const syncQueued = useRef(false);

  const recordConnectionFailure = useCallback((failure: unknown) => {
    walletRecovery.require();
    unavailableAttempts.current = failure instanceof NetworkReadinessError ? 0 : unavailableAttempts.current + 1;
    if (!alive.current) return;
    connectionReady.current = false;
    setSyncTrusted(false);
    const waiting = failure instanceof NetworkReadinessError ? failure.info : null;
    setNetwork(waiting); setNetworkWaiting(waiting);
    setConnectionError(waiting ? '' : errorMessage(failure));
  }, [walletRecovery]);

  const getNetwork = useCallback((): Promise<NetworkInfo> => {
    if (connectionInFlight.current) return connectionInFlight.current;
    const pending = (async () => {
      try {
        const info = await provider.network();
        unavailableAttempts.current = 0;
        if (alive.current) { connectionReady.current = true; setNetwork(info); setNetworkWaiting(null); setConnectionError(''); }
        return info;
      } catch (failure) {
        const message = errorMessage(failure);
        recordConnectionFailure(failure);
        throw new ConnectionError(message, failure);
      } finally { connectionInFlight.current = null; rescheduleConnection.current?.(); }
    })();
    connectionInFlight.current = pending;
    return pending;
  }, [provider, recordConnectionFailure]);

  const checkConnection = useCallback(async (): Promise<boolean> => {
    if (alive.current) setCheckingConnection(true);
    try { await getNetwork(); return true; }
    catch { return false; }
    finally { if (alive.current) setCheckingConnection(false); }
  }, [getNetwork]);

  const lock = useCallback(async (reason = 'Wallet locked.') => {
    sessionEpoch.current += 1;
    syncGeneration.current += 1; knownWallet.current = null; syncQueued.current = false;
    walletRecovery.succeeded();
    setUnlocked(false); setSeed(null); setSeedObscured(false); setConfirmSeed(false); setPlan(null); setSigned(null); setReceipt(null);
    setRetryRequired(false); setDiscardAllowed(false); setSnapshot(null); setCachedDisplay(null); setReceive(null); setChange(null); setOwnedAddresses([]);
    setSyncing(false); setSyncError(''); setSyncTrusted(false); setAwaitingReconciliation(false);
    setEncryptedImport(''); setError(''); setNotice(reason); setTab('overview'); setSettingsMode('menu');
    setProgress(''); setBusy(false); busyRef.current = false;
    setSendMax(false); setSendAmount(''); setSendRecipient('');
    await wallet.lock();
  }, [wallet, walletRecovery]);

  const run = useCallback(async (operation: (active: () => boolean) => Promise<void>, clearMessages = true) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true);
    if (clearMessages) { setError(''); setNotice(''); }
    const epoch = sessionEpoch.current;
    const active = () => alive.current && epoch === sessionEpoch.current;
    try { await operation(active); }
    catch (failure) { if (active() && !(failure instanceof ConnectionError)) setError(errorMessage(failure)); }
    finally { if (alive.current && epoch === sessionEpoch.current) { busyRef.current = false; setBusy(false); setProgress(''); } }
  }, []);

  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    void wallet.getMetadata().then(stored => { if (!cancelled) setMetadata(stored); })
      .catch(() => { if (!cancelled) setError('The local wallet could not be read. Do not clear browser storage without your backup.'); })
      .finally(() => { if (!cancelled) setInitialized(true); });
    void checkConnection();
    return () => { cancelled = true; alive.current = false; queueMicrotask(() => { if (!alive.current) void wallet.lock(); }); };
  }, [checkConnection, wallet]);

  useEffect(() => {
    const hidden = () => { if (document.hidden && seed) setSeedObscured(true); };
    const blurred = () => { if (seed) setSeedObscured(true); };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('blur', blurred);
    return () => { document.removeEventListener('visibilitychange', hidden); window.removeEventListener('blur', blurred); };
  }, [seed]);

  useEffect(() => {
    if (!unlocked) return;
    lastActivity.current = Date.now();
    const epoch = sessionEpoch.current;
    const expired = () => Date.now() - lastActivity.current >= INACTIVITY_MS;
    const checkIdle = () => { if (expired()) { void lock(); return true; } return false; };
    const activity = () => {
      if (checkIdle()) return;
      lastActivity.current = Date.now();
      void wallet.recordActivity().catch(() => {
        if (alive.current && epoch === sessionEpoch.current) void lock('Wallet session ended. Unlock again to continue.');
      });
    };
    const returned = () => { if (!document.hidden && !checkIdle()) activity(); };
    window.addEventListener('pointerdown', activity); window.addEventListener('keydown', activity);
    window.addEventListener('focus', returned); document.addEventListener('visibilitychange', returned);
    const timer = window.setInterval(checkIdle, 5_000);
    return () => { clearInterval(timer); window.removeEventListener('pointerdown', activity); window.removeEventListener('keydown', activity); window.removeEventListener('focus', returned); document.removeEventListener('visibilitychange', returned); };
  }, [unlocked, lock, wallet]);

  useEffect(() => {
    setQr('');
    if (!receive) return;
    let cancelled = false;
    QRCode.toDataURL(receive.address, { width: 240, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#17262e', light: '#ffffff' } })
      .then(value => { if (!cancelled) setQr(value); }).catch(() => { if (!cancelled) setError('The receive QR code could not be generated. Use the full address below.'); });
    return () => { cancelled = true; };
  }, [receive?.address]);

  const synchronize = useCallback((meta: WalletMetadata, active: () => boolean): Promise<void> => {
    const epoch = sessionEpoch.current;
    const generation = syncGeneration.current;
    const token = Symbol('wallet-refresh');
    if (syncInFlight.current?.epoch === epoch) return syncInFlight.current.promise;
    const promise = (async () => {
      if (active()) { setSyncing(true); setSyncTrusted(false); }
      try {
        const currentNetwork = await getNetwork();
        if (!active()) return;
        if (currentNetwork.network !== meta.network) throw new Error('This wallet belongs to a different network. Connect the matching gateway to continue.');
        // Fetch independent fee data while the address view is verified. Convert
        // rejection to a result immediately so an earlier scan failure cannot
        // leave an unhandled request behind.
        const feeRequest = provider.fees().then(policy => ({ policy }), failure => ({ failure }));
        const discovered = knownWallet.current
          ? await refreshKnownWallet(wallet, provider, knownWallet.current, undefined, readReceiveCursor(meta.id))
          : await discoverWallet(wallet, provider, undefined, readReceiveCursor(meta.id));
        if (!active()) return;
        if (!discovered.snapshot.complete || !discovered.snapshot.network.ready) throw new Error('The network view is incomplete. Your last known balance is retained.');
        const accepted = loadAcceptedTransfers(meta);
        const pending = accepted.filter(record => !isPendingTransferReconciled(discovered.snapshot, record, discovered.ownedAddresses));
        const displayed = reconcilePendingTransfers(discovered.snapshot, pending, discovered.ownedAddresses);
        rememberReceiveCursor(meta.id, discovered.receive.index);
        if (pending.length !== accepted.length) retainAcceptedTransfers(meta, pending);
        knownWallet.current = discovered;
        setCachedDisplay(null); setSnapshot(displayed); setReceive(discovered.receive); setChange(discovered.change); setOwnedAddresses(discovered.ownedAddresses);
        setAwaitingReconciliation(pending.length > 0);
        // Retain only the authoritative view. A local transfer projection must
        // not restore an older prepayment balance after locking or reloading.
        // Display persistence is optional and must never fail a successful sync.
        void wallet.saveDisplayCache(pending.length ? null : discovered).catch(() => {});
        const feeResult = await feeRequest;
        if ('failure' in feeResult) throw new Error('Fee estimates unavailable. Sending paused; retrying automatically.');
        const policy = feeResult.policy;
        if (!active()) return;
        setFees(policy); setFeeRate(previous => previous || ceilRate(policy.suggestedRate));
        setSyncError(''); setSyncTrusted(pending.length === 0 && generation === syncGeneration.current);
        walletRecovery.succeeded();
      } catch (failure) {
        if (active()) {
          // The tip can change after /network succeeds but before /wallet/sync.
          // Use the same light readiness probes and immediate recovery in both paths.
          if (failure instanceof NetworkReadinessError) {
            recordConnectionFailure(failure);
            rescheduleConnection.current?.();
          }
          walletRecovery.failed();
          setSyncError(failure instanceof NetworkReadinessError || failure instanceof ConnectionError ? '' : errorMessage(failure));
          setSyncTrusted(false);
        }
        throw failure;
      } finally {
        if (alive.current && epoch === sessionEpoch.current) setSyncing(false);
        if (syncInFlight.current?.token === token) syncInFlight.current = null;
        rescheduleConnection.current?.();
      }
    })();
    syncInFlight.current = { epoch, token, promise };
    return promise;
  }, [provider, wallet, getNetwork, recordConnectionFailure, walletRecovery]);

  const requestSync = useCallback((meta: WalletMetadata): void => {
    const epoch = sessionEpoch.current;
    const active = () => alive.current && epoch === sessionEpoch.current;
    if (syncInFlight.current?.epoch === epoch) {
      syncQueued.current = true;
      void syncInFlight.current.promise.catch(() => {}).finally(() => {
        if (syncQueued.current && active()) { syncQueued.current = false; requestSync(meta); }
      });
      return;
    }
    void synchronize(meta, active).catch(() => {});
  }, [synchronize]);

  useEffect(() => {
    if (!initialized) return;
    let cancelled = false;
    let polling = false;
    let timer: ReturnType<typeof setTimeout>;
    const epoch = sessionEpoch.current;
    const canRefreshWallet = unlocked && !!metadata?.backupConfirmed && !seed && !plan;
    const current = () => !cancelled && alive.current && epoch === sessionEpoch.current;
    const schedule = () => {
      clearTimeout(timer);
      const delay = canRefreshWallet ? walletRecovery.delay(connectionReady.current, unavailableAttempts.current)
        : networkRetryDelay(connectionReady.current, unavailableAttempts.current);
      if (current()) timer = setTimeout(() => { void poll(); }, delay);
    };
    const poll = async (refreshOnReturn = false) => {
      if (!current() || polling) return;
      clearTimeout(timer);
      if (document.hidden) { schedule(); return; }
      polling = true;
      try {
        // Healthy active wallets already check the network during their normal
        // refresh. Blocked wallets only probe this small readiness endpoint.
        if (!connectionReady.current || !canRefreshWallet || syncError || refreshOnReturn) {
          const wasReady = connectionReady.current;
          const connected = await checkConnection();
          if (current() && connected && canRefreshWallet && metadata && (!wasReady || refreshOnReturn || walletRecovery.due())
            && !busyRef.current && syncInFlight.current?.epoch !== epoch) requestSync(metadata);
        } else if (walletRecovery.due() && metadata && !busyRef.current && syncInFlight.current?.epoch !== epoch) {
          requestSync(metadata);
        }
      } finally { polling = false; schedule(); }
    };
    const returned = () => { if (!document.hidden) void poll(true); };
    rescheduleConnection.current = schedule;
    window.addEventListener('online', returned);
    document.addEventListener('visibilitychange', returned);
    if (syncError && connectionReady.current) void poll(); else schedule();
    return () => {
      cancelled = true; clearTimeout(timer);
      if (rescheduleConnection.current === schedule) rescheduleConnection.current = null;
      window.removeEventListener('online', returned); document.removeEventListener('visibilitychange', returned);
    };
  }, [initialized, unlocked, metadata?.id, metadata?.backupConfirmed, !!seed, !!plan, syncError, checkConnection, requestSync, walletRecovery]);

  useEffect(() => {
    if (!unlocked || !metadata?.backupConfirmed || seed) return;
    requestSync(metadata);
  }, [metadata?.id, metadata?.backupConfirmed, unlocked, seed, requestSync]);

  useEffect(() => {
    if (!unlocked || !metadata || seed) return;
    try {
      const pending = loadJournal(metadata);
      setJournalBlocked(!!pending);
      if (pending) { setPlan(pending.plan); setSigned(pending.signed); setRetryRequired(true); setTab('send'); setNotice('An unfinished transfer was recovered. Check and retry this same transaction before making another payment.'); }
    } catch (failure) { setJournalBlocked(true); setError(errorMessage(failure)); }
  }, [unlocked, metadata?.id, seed]);

  useEffect(() => {
    if (!unlocked || !metadata?.backupConfirmed || seed || plan) return;
    const epoch = sessionEpoch.current;
    const pending = awaitingReconciliation || snapshot?.history.some(entry => entry.status === 'pending') || snapshot?.utxos.some(coin =>
      coin.verified && coin.classification === 'native' && (coin.confirmations < snapshot.network.minConfirmations || (coin.coinbase && coin.confirmations < snapshot.network.coinbaseMaturity)));
    const interval = window.setInterval(() => {
      if (!document.hidden && !busyRef.current && epoch === sessionEpoch.current && connectionReady.current) requestSync(metadata);
    }, pending && !syncError ? 10_000 : 30_000);
    return () => clearInterval(interval);
  }, [metadata, unlocked, seed, plan, snapshot, awaitingReconciliation, syncError, requestSync]);

  const startCreate = (event: FormEvent<HTMLFormElement>) => {
    const { data, form } = submitData(event);
    void run(async active => {
      const password = validateNewPassword(data);
      if (!network?.ready) throw new Error('Wait for a ready network connection before creating a wallet.');
      const created = await wallet.create(password, network.network);
      form.reset();
      if (!active()) return;
      setMetadata(created.metadata); setUnlocked(true); setSeed({ mnemonic: created.mnemonic, purpose: 'create' }); setSeedObscured(document.hidden); setConfirmSeed(false);
    });
  };
  const startRestore = (event: FormEvent<HTMLFormElement>) => {
    const { data, form } = submitData(event);
    setRestoreError('');
    // Native validation can stop submit before our asynchronous error handler runs.
    const invalid = Array.from(form.elements).find(element =>
      (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) && !element.validity.valid,
    ) as HTMLInputElement | HTMLTextAreaElement | undefined;
    if (invalid) { setRestoreError(invalid.validationMessage); return; }
    void run(async active => {
      try {
        if (!network?.ready) throw new Error('Connect to a ready gateway before restoring your wallet.');
        let restored: WalletMetadata;
        if (restoreMode === 'seed') {
          const password = validateNewPassword(data);
          restored = await wallet.restore(requiredText(data, 'mnemonic'), password, network.network);
        } else {
          if (!encryptedImport.trim()) throw new Error('Choose your encrypted wallet backup file.');
          restored = await wallet.importBackup(encryptedImport, requiredText(data, 'password'));
        }
        if (!active()) return;
        form.reset();
        setMetadata(restored); setEncryptedImport('');
        if (restored.network !== network.network) { await lock('Backup restored. Connect a gateway for its network before unlocking.'); return; }
        setUnlocked(true); setTab('overview');
      } catch (failure) {
        if (active()) setRestoreError(errorMessage(failure));
      }
    });
  };
  const unlockWallet = (event: FormEvent<HTMLFormElement>) => {
    const { data, form } = submitData(event);
    void run(async active => {
      const password = requiredText(data, 'password');
      const opened = await wallet.unlock(password);
      form.reset();
      if (!active()) return;
      let cache: WalletDisplayCache | null = null;
      try {
        if (!hasJournal(opened) && loadAcceptedTransfers(opened).length === 0) cache = await wallet.loadDisplayCache();
        if (cache) {
          const cursor = readReceiveCursor(opened.id);
          if (cursor > cache.receive.index && cursor < 180) {
            const selected = cache.ownedAddresses.find(record => record.branch === 0 && record.index === cursor)
              ?? (await wallet.getAddresses(0, cursor, 1))[0];
            const ownedAddresses = cache.ownedAddresses.some(record => record.address === selected.address)
              ? cache.ownedAddresses : [...cache.ownedAddresses, selected];
            const addresses = cache.snapshot.addresses.some(record => record.address === selected.address)
              ? cache.snapshot.addresses : [...cache.snapshot.addresses, { address: selected.address, used: false }];
            cache = { ...cache, receive: selected, ownedAddresses, snapshot: { ...cache.snapshot, addresses } };
          }
        }
      } catch { /* A missing or damaged optional display cache never blocks unlock. */ }
      if (!active()) return;
      if (cache) {
        setCachedDisplay(cache); setSnapshot(cache.snapshot); setReceive(cache.receive); setChange(cache.change); setOwnedAddresses(cache.ownedAddresses);
        setSyncTrusted(false);
      }
      setMetadata(opened); setUnlocked(true);
      if (!opened.backupConfirmed) {
        const mnemonic = await wallet.revealMnemonic(password);
        if (!active()) return;
        setSeed({ mnemonic, purpose: 'create' }); setSeedObscured(document.hidden); setConfirmSeed(false);
      }
    });
  };
  const confirmBackup = (event: FormEvent<HTMLFormElement>) => {
    const { data, form } = submitData(event);
    void run(async active => {
      if (!seed) return;
      const words = seed.mnemonic.split(' ');
      if (CHALLENGE.some(index => requiredText(data, `word${index}`).trim().toLowerCase() !== words[index])) throw new Error('Those words do not match. Check your written backup and try again.');
      const updated = await wallet.acknowledgeBackup();
      form.reset();
      if (!active()) return;
      setMetadata(updated); setSeed(null); setConfirmSeed(false); setNotice('Backup confirmed. Your wallet is ready.');
    });
  };
  const refresh = () => { if (metadata && !busyRef.current) requestSync(metadata); };
  const copyAddress = () => { void run(async active => { if (!receive) return; await navigator.clipboard.writeText(receive.address); if (active()) setNotice('Receive address copied.'); }); };
  const freshAddress = () => { void run(async active => {
    if (!metadata || !receive || !snapshot) return;
    const used = new Set(snapshot.addresses.filter(record => record.used).map(record => record.address));
    const baseline = Math.max(-1, ...ownedAddresses.filter(record => record.branch === 0 && used.has(record.address)).map(record => record.index)) + 1;
    if (receive.index >= baseline + 19) throw new Error('Receive a payment on an existing address before generating more. This keeps all addresses recoverable from your recovery phrase.');
    if (receive.index + 1 >= 180) throw new Error('This wallet has reached its supported receive address range. Use your existing address until extended recovery support is available.');
    const [next] = await wallet.getAddresses(0, receive.index + 1, 1);
    if (!active()) return;
    rememberReceiveCursor(metadata.id, next.index); setReceive(next);
    setOwnedAddresses(previous => previous.some(address => address.address === next.address) ? previous : [...previous, next]);
    setNotice('A fresh receive address is ready. Previous addresses still belong to your wallet.');
  }); };

  const prepareSend = (event: FormEvent<HTMLFormElement>) => {
    const { data } = submitData(event);
    void run(async active => {
      if (!metadata || !snapshot || !change || !fees) throw new Error('Synchronize your wallet before sending.');
      if (!syncTrusted || syncInFlight.current?.epoch === sessionEpoch.current) throw new Error('Wait for a complete wallet refresh before sending.');
      if (hasJournal(metadata)) throw new Error('Resolve your saved transfer before preparing another payment.');
      if (!snapshot.complete || !snapshot.network.ready || Date.now() - Date.parse(snapshot.observedAt) > 120_000) throw new Error('Refresh your wallet before sending. Its network view must be complete and current.');
      const currentNetwork = await getNetwork();
      if (!active()) return;
      if (currentNetwork.network !== metadata.network || currentNetwork.tipHash !== snapshot.network.tipHash) throw new Error('The network changed since your last refresh. Synchronize your wallet before sending.');
      const currentFees = await provider.fees();
      if (!active()) return;
      setNetwork(currentNetwork); setFees(currentFees);
      const rate = requiredText(data, 'feeRate').trim();
      if (!/^[1-9]\d*$/.test(rate)) throw new Error('Use a whole, positive fee rate in atomic units per vbyte.');
      const floor = [currentFees.relayFloorUnitsPerVbyte, currentFees.mempoolFloorUnitsPerVbyte].map(ceilRate).reduce((a, b) => BigInt(a) > BigInt(b) ? a : b);
      if (BigInt(rate) < BigInt(floor)) throw new Error(`The current minimum fee rate is ${floor} units/vbyte.`);
      const prepared = await wallet.prepareTransfer({ network: metadata.network, recipient: requiredText(data, 'recipient').trim(),
        amountUnits: sendMax ? '0' : parseTsc(requiredText(data, 'amount')), sendMax, feeRate: rate,
        utxos: eligibleUtxos(snapshot), ownedAddresses, change });
      if (!active()) return;
      setPlan(prepared); setSigned(null); setReceipt(null); setRetryRequired(false); setDiscardAllowed(false);
    });
  };
  const publish = () => { void run(async active => {
    if (!plan || !metadata) return;
    const currentNetwork = await getNetwork();
    if (!active()) return;
    if (currentNetwork.network !== plan.network) throw new Error('The gateway network does not match this transfer.');
    let transfer = signed;
    if (!transfer) {
      setProgress('Signing on this device…');
      transfer = await wallet.signTransfer(plan.id);
      if (!active()) return;
      setSigned(transfer);
    }
    saveJournal(metadata, plan, transfer);
    setJournalBlocked(true);
    setProgress('Checking the signed transaction…');
    try {
      const validation = await provider.validate(transfer.rawHex);
      if (!active()) return;
      if (validation.txid !== transfer.txid) throw new Error('The gateway returned an unexpected transaction identifier.');
      if (!validation.allowed && !validation.alreadyKnown) {
        const saved = loadJournal(metadata);
        if (saved && !saved.broadcastAttempted) {
          clearJournal(metadata); setJournalBlocked(false); setSigned(null); setPlan(null); setRetryRequired(false);
          setError(validation.reason || 'The node rejected this transaction. Nothing was broadcast. Refresh before trying again.');
          return;
        }
        setDiscardAllowed('canDiscard' in validation && validation.canDiscard === true);
        throw new Error(validation.reason || 'The node rejected this transaction. Its previous publication status still needs to be resolved.');
      }
      setProgress('Publishing your transaction…');
      markBroadcastAttempted(metadata);
      const broadcast = await provider.broadcast(transfer.rawHex);
      if (!active()) return;
      if (broadcast.txid !== transfer.txid) throw new Error('The broadcast response could not be verified. Check this transaction before retrying.');
      const accepted = rememberAcceptedTransfer(metadata, plan, transfer);
      syncGeneration.current += 1;
      setSnapshot(previous => previous ? reconcilePendingTransfers(previous, accepted, ownedAddresses) : previous);
      setSyncTrusted(false); setAwaitingReconciliation(true);
      clearJournal(metadata); setJournalBlocked(false); setDiscardAllowed(false);
      setReceipt({ txid: transfer.txid, feeUnits: transfer.feeUnits, vsize: transfer.vsize });
      setSigned(null); setPlan(null); setRetryRequired(false); setNotice('Transaction published. Waiting for confirmation.');
      setSendMax(false); setSendAmount(''); setSendRecipient('');
    } catch (failure) {
      if (active()) { setRetryRequired(true); setError(errorMessage(failure)); }
      return;
    }
    if (metadata && active()) requestSync(metadata);
  }); };
  const cancelTransfer = () => {
    if (signed) { setTab('overview'); return; }
    setPlan(null); setSigned(null); setRetryRequired(false); setError('');
  };
  const discardRejectedTransfer = () => { void run(async active => {
    if (!metadata || !signed) return;
    const current = await getNetwork();
    if (!active()) return;
    if (current.network !== metadata.network) throw new Error('Connect the wallet’s network before resolving this transfer.');
    const validation = await provider.validate(signed.rawHex);
    if (!active()) return;
    if (validation.txid !== signed.txid || validation.allowed || validation.alreadyKnown || !('canDiscard' in validation) || validation.canDiscard !== true) {
      setDiscardAllowed(false);
      throw new Error('The transfer can no longer be safely canceled. Check and retry the saved transaction instead.');
    }
    clearJournal(metadata); setJournalBlocked(false); setDiscardAllowed(false); setRetryRequired(false); setSigned(null); setPlan(null);
    setNotice('Rejected transfer canceled after checking its inputs. Your wallet is refreshing before another payment.');
    await synchronize(metadata, active);
  }); };

  const exportWallet = (event: FormEvent<HTMLFormElement>) => {
    const { data, form } = submitData(event);
    void run(async active => {
      const backup = await wallet.exportBackup(requiredText(data, 'password'));
      form.reset(); if (!active()) return;
      const url = URL.createObjectURL(new Blob([backup], { type: 'application/json' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `tensorcash-${metadata?.network}-encrypted-backup.json`; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
      setSettingsMode('menu'); setNotice('Encrypted backup downloaded. Keep its password separately.');
    });
  };
  const revealSeed = (event: FormEvent<HTMLFormElement>) => {
    const { data, form } = submitData(event);
    void run(async active => {
      const mnemonic = await wallet.revealMnemonic(requiredText(data, 'password'));
      form.reset(); if (!active()) return;
      setSeed({ mnemonic, purpose: 'reveal' }); setSeedObscured(document.hidden); setConfirmSeed(false);
    });
  };
  const changePassword = (event: FormEvent<HTMLFormElement>) => {
    const { data, form } = submitData(event);
    void run(async active => {
      const password = validateNewPassword(data, 'newPassword');
      await wallet.changePassword(requiredText(data, 'currentPassword'), password);
      form.reset(); if (!active()) return;
      setSettingsMode('menu'); setNotice('Your wallet password has been changed. Older encrypted backups still use their original password.');
    });
  };
  const resetWallet = (event: FormEvent<HTMLFormElement>) => {
    const { data, form } = submitData(event);
    void run(async active => {
      if (metadata && hasJournal(metadata)) throw new Error('Resolve your saved transfer before removing this wallet.');
      if (requiredText(data, 'confirmation') !== 'REMOVE WALLET') throw new Error('Type REMOVE WALLET exactly to continue.');
      await wallet.reset(requiredText(data, 'password'));
      form.reset(); if (!active()) return;
      if (metadata) { localStorage.removeItem(receiveCursorKey(metadata.id)); localStorage.removeItem(acceptedTransfersKey(metadata.id)); }
      await lock('Local wallet removed. Your recovery phrase can restore it.'); setMetadata(null); setWelcomeMode('start');
    });
  };

  const snapshotCached = !!cachedDisplay;
  const lastKnownBalance = snapshotCached || !!syncError || !!connectionError || !!networkWaiting;
  const balances = cachedDisplay ? {
    spendable: BigInt(cachedDisplay.balances.spendable),
    pending: BigInt(cachedDisplay.balances.pending),
    unsupported: BigInt(cachedDisplay.balances.unsupported),
  } : snapshot ? walletBalances(snapshot) : null;
  const totalBalance = balances ? balances.spendable + balances.pending : null;
  const syncState = syncing ? snapshot ? 'refreshing' : 'loading' : lastKnownBalance ? 'stale' : snapshot ? 'idle' : 'loading';
  const canSend = syncTrusted && !syncing && !connectionError && !networkWaiting && !journalBlocked && !!snapshot?.complete && !!snapshot.network.ready && !!metadata?.backupConfirmed && !!balances && balances.spendable > 0n;
  const maxQuote = (() => {
    if (!snapshot || snapshotCached || !fees || !/^[1-9]\d*$/.test(feeRate)) return null;
    try { return quoteNativeSendMax(eligibleUtxos(snapshot), feeRate); } catch { return null; }
  })();
  const sendAmountValue = sendMax && maxQuote ? formatTsc(maxQuote.amountUnits) : sendAmount;
  const fillSendMax = () => {
    if (!canSend || !maxQuote) return;
    setSendMax(true); setSendAmount(formatTsc(maxQuote.amountUnits));
  };
  const mismatch = !!metadata && !!network && metadata.network !== network.network;
  const displayNetwork = snapshot?.network ?? network;
  const receiptLink = receipt && displayNetwork ? safeExplorerLink(displayNetwork.explorerUrl, receipt.txid) : null;
  const receiptConfirmation = receipt && displayNetwork ? confirmationView(snapshot?.history.find(entry => entry.txid === receipt.txid) ?? {
    txid: receipt.txid, deltaUnits: '0', feeUnits: receipt.feeUnits, status: 'pending', confirmations: 0, blockHeight: null, timestamp: null,
  }, displayNetwork) : null;

  return <>
    <header className="site-header"><div className="header-inner"><a href="#" className="brand" aria-label="TensorCash Wallet home" onClick={event => { event.preventDefault(); if (unlocked && !seed) setTab('overview'); }}><img className="brand-mark" src="/brand/logo.svg" alt="" width="40" height="40" /><span className="brand-wordmark">TensorCash<span className="brand-subtitle">wallet</span></span></a>
      <div className="header-actions"><a className="header-source" href={SOURCE_URL} target="_blank" rel="noreferrer" aria-label="View source on GitHub" title="View source on GitHub"><GitHubMark /></a><NetworkBadge network={network} />{unlocked && <button className="header-lock" aria-label="Lock" onClick={() => void lock()}><Icon name="lock" /><span>Lock</span></button>}</div></div></header>
    <main className={unlocked && !seed ? 'main wallet-main' : 'main onboarding-main'}>
      <div className="toast-stack" aria-label="Notifications">
        {connectionError && !unlocked && <Toast message={connectionError} tone="error" dismissLabel="Dismiss connection error" onDismiss={() => setConnectionError('')} action={<button className="inline-link connection-retry" type="button" disabled={checkingConnection} onClick={() => void checkConnection()}>{checkingConnection ? <><span className="spinner" aria-hidden="true" />Connecting…</> : 'Retry connection'}</button>} />}
        {error && <Toast message={error} tone="error" dismissLabel="Dismiss error" onDismiss={() => setError('')} />}
        {notice && <Toast message={notice} tone="success" dismissLabel="Dismiss notice" onDismiss={() => setNotice('')} />}
      </div>
      <div className="announcements">{networkWaiting && !unlocked && <NetworkUpdate network={networkWaiting} hasWallet={!!metadata} unlocked={false} hasBalance={false} />}{busy && <div className="working" role="status"><span className="spinner" aria-hidden="true" />{progress || 'Working securely on your device…'}</div>}</div>
      {!initialized ? <section className="card onboarding-card"><h1>Opening your wallet</h1><p className="muted">Checking this device and connecting to the network.</p></section>
      : seed && seedObscured ? <section className="card onboarding-card"><span className="eyebrow">Your recovery phrase</span><h1>Recovery phrase hidden</h1><p className="muted">Your backup is still open. Continue when your screen is private.</p><button className="button primary full" onClick={() => setSeedObscured(false)}>{seed.purpose === 'create' ? 'Continue backup' : 'Show recovery phrase again'}</button>{seed.purpose === 'reveal' && <button className="button text full" onClick={() => { setSeed(null); setSeedObscured(false); setSettingsMode('menu'); }}>Hide recovery phrase</button>}</section>
      : seed ? <section className="card onboarding-card seed-card"><span className="eyebrow">{seed.purpose === 'create' ? 'Secure your wallet' : 'Your recovery phrase'}</span><h1>{confirmSeed ? 'Check your written backup' : 'Write down these 12 words'}</h1>
        <p className="muted">Your recovery phrase gives full access to your funds. Keep it offline and never share it with anyone.</p>
        {!confirmSeed ? <><ol className="seed-grid">{seed.mnemonic.split(' ').map((word, index) => <li key={index}><span>{index + 1}</span>{word}</li>)}</ol>
          <div className="callout">A wallet password protects this device. Only your recovery phrase can restore access if this device is lost.</div>
          {seed.purpose === 'create' ? <button className="button primary full" disabled={busy} onClick={() => { setConfirmSeed(true); setError(''); }}>I have written down all 12 words</button>
          : <button className="button primary full" onClick={() => { setSeed(null); setSettingsMode('menu'); }}>Hide recovery phrase</button>}</>
        : <form onSubmit={confirmBackup}><div className="challenge-grid">{CHALLENGE.map(index => <Field key={index} label={`Word ${index + 1}`}><input name={`word${index}`} required autoComplete="off" autoCapitalize="none" spellCheck={false} /></Field>)}</div><button className="button primary full" disabled={busy}>Confirm backup & open wallet</button><button className="button text full" type="button" disabled={busy} onClick={() => setConfirmSeed(false)}>Show recovery phrase again</button></form>}
      </section>
      : !unlocked && metadata ? <section className="card onboarding-card"><span className="eyebrow">Welcome back</span><h1>Your wallet, on this device.</h1><p className="muted">Unlock your encrypted wallet to send and receive TensorCash.</p>
        <form onSubmit={unlockWallet}><PasswordField /><button className="button primary full" disabled={busy || mismatch}>Unlock wallet</button></form>
        {mismatch && <div className="callout warning">This wallet uses {metadata.network}. Connect a matching gateway before unlocking.</div>}
      </section>
      : !unlocked ? <><section className="onboarding-layout"><div className="intro"><span className="eyebrow">TensorCash · Self-custody wallet</span><h1>A simple home <br />for your TensorCash.</h1><p>A browser wallet for native TSC. Your keys are generated and encrypted on this device, and every payment is signed here before it reaches the network.</p>
          <dl className="intro-facts"><div><dt>Backup</dt><dd>12-word recovery phrase</dd></div><div><dt>Encryption</dt><dd>scrypt + AES-256-GCM, in this browser</dd></div><div><dt>Account</dt><dd>None. No email, no sign-up.</dd></div></dl>
          <p className="intro-links"><a className="intro-source" href={SOURCE_URL} target="_blank" rel="noreferrer"><GitHubMark />Review the source <span aria-hidden="true">↗</span></a><span>Open source · MIT licence</span></p></div>
        <div className="card onboarding-card">{welcomeMode === 'start' ? <><span className="eyebrow">Get started</span><h2>Your keys. Your wallet.</h2><p className="muted">Create a new wallet or recover one you already own.</p><button className="button primary full" disabled={busy || !network?.ready} onClick={() => setWelcomeMode('create')}>Create a wallet <span>→</span></button><button className="button secondary full" disabled={busy || !network?.ready} onClick={() => setWelcomeMode('restore')}>Restore a wallet</button><p className="footnote">Keep a written backup. Browser storage can be cleared or lost.</p></>
          : welcomeMode === 'create' ? <><button className="back-link" onClick={() => setWelcomeMode('start')} disabled={busy}>← Back</button><h2>Create your wallet</h2><p className="muted">Choose a strong password for the encrypted wallet on this device.</p><form onSubmit={startCreate}><PasswordField confirm /><PasswordField name="confirmPassword" label="Confirm password" confirm /><Field label="Network"><select value={network?.network ?? ''} disabled><option value="mainnet">TensorCash mainnet</option><option value="regtest">Regtest — test coins</option><option value="">Connecting…</option></select></Field><p className="footnote">The network is set by your connected gateway.</p><button className="button primary full" disabled={busy || !network?.ready}>Create & back up wallet</button></form></>
          : <><button className="back-link" onClick={() => { setWelcomeMode('start'); setEncryptedImport(''); setRestoreError(''); }} disabled={busy}>← Back</button><h2>Restore your wallet</h2><p className="muted">Recover your addresses and funds using your wallet backup.</p><div className="segmented" role="group" aria-label="Backup type"><button className={restoreMode === 'seed' ? 'selected' : ''} disabled={busy} onClick={() => { setRestoreMode('seed'); setRestoreError(''); }}>Recovery phrase</button><button className={restoreMode === 'file' ? 'selected' : ''} disabled={busy} onClick={() => { setRestoreMode('file'); setRestoreError(''); }}>Encrypted file</button></div>
            <form onSubmit={startRestore} noValidate>{restoreMode === 'seed' ? <><Field label="12-word recovery phrase" hint="English words, separated by spaces. This wallet uses no additional BIP39 passphrase."><textarea name="mnemonic" rows={3} required autoComplete="off" autoCapitalize="none" spellCheck={false} aria-invalid={restoreError ? true : undefined} aria-describedby={restoreError ? 'restore-error' : undefined} /></Field><PasswordField label="New wallet password" confirm /><PasswordField name="confirmPassword" label="Confirm new password" confirm /></>
              : <><Field label="Encrypted JSON backup"><input type="file" accept="application/json,.json" required onChange={event => { const file = event.target.files?.[0]; if (!file) { setEncryptedImport(''); return; } if (file.size > 8192) { setEncryptedImport(''); setRestoreError('The backup file exceeds the supported 8 KB size.'); event.target.value = ''; return; } void file.text().then(setEncryptedImport).catch(() => { setEncryptedImport(''); setRestoreError('The backup file could not be read.'); }); }} /></Field><PasswordField label="Backup password" /></>}{restoreError && <div id="restore-error" ref={restoreErrorRef} className="message error restore-error" role="alert" tabIndex={-1}>{restoreError}</div>}<button className="button primary full" disabled={busy || !network?.ready}>Restore wallet</button></form></>}</div></section>
        <section className="how" aria-labelledby="how-heading"><div className="how-head"><h2 id="how-heading">How it works</h2><p>Your keys stay inside the line. Only signed transactions cross it.</p></div>
          <LandingDiagram />
          <ol className="how-steps">
            <li><span className="how-num">01</span><h3>Created on your device</h3><p>A 12-word recovery phrase is generated from your browser’s cryptographic randomness. The wallet is stored encrypted with your password and locks after five minutes of inactivity.</p></li>
            <li><span className="how-num">02</span><h3>Signed where you review it</h3><p>You check the recipient, amount and fee. A dedicated worker signs exactly that transfer. Your phrase, password and private keys are never sent to the server.</p></li>
            <li><span className="how-num">03</span><h3>Relayed, not held</h3><p>The gateway reads balances for your public addresses, checks the signed transaction against its TensorCash node and publishes it. It holds no keys and cannot sign for you.</p></li>
          </ol>
          <p className="how-note">Initial release, not yet independently audited. Keep your recovery phrase offline and start with small amounts.</p></section></>
      : <>
        <div className="wallet-heading"><div><span className="eyebrow">Your wallet</span><h1>Keep it simple.</h1></div><div className="refresh-control"><span className={`sync-status ${lastKnownBalance && !networkWaiting ? 'stale' : ''}`} data-testid="wallet-sync" data-sync-state={syncState} role="status" aria-live={snapshot ? 'off' : 'polite'}>{syncing ? <><span className="spinner" />{snapshot ? 'Updating' : 'Checking balance'}</> : networkWaiting ? 'Updating' : syncError || connectionError ? 'Retrying' : awaitingReconciliation ? 'Updating payment' : snapshotCached ? 'Last known' : snapshot ? 'Up to date' : 'Checking balance'}</span><button className="button compact secondary" onClick={refresh} disabled={busy || syncing}><Icon name="refresh" />Refresh</button></div></div>
        <nav className="tabs" aria-label="Wallet sections">{(['overview', 'receive', 'send', 'settings'] as Tab[]).map(item => <button key={item} aria-current={tab === item ? 'page' : undefined} className={tab === item ? 'active' : ''} disabled={busy && item !== tab} onClick={() => { setTab(item); setError(''); }}><Icon name={item === 'overview' ? 'wallet' : item === 'send' ? 'arrow-up' : item === 'receive' ? 'arrow-down' : 'settings'} />{item.charAt(0).toUpperCase() + item.slice(1)}</button>)}</nav>
        {snapshot?.warnings.map((warning, index) => <div key={index} className="callout warning">{warning}</div>)}
        {networkWaiting ? <NetworkUpdate network={networkWaiting} hasWallet={!!metadata} unlocked hasBalance={!!balances} /> : (syncError || connectionError) && <div className="callout warning sync-warning" role="status">{connectionError || syncError}</div>}
        {journalBlocked && tab !== 'send' && <div className="callout warning">A saved transfer needs attention before you send another payment. <button className="inline-link" onClick={() => setTab('send')}>Review saved transfer</button></div>}
        {tab === 'overview' && <>
          <section className="card balance-card" aria-label="Wallet balances"><div className="balance-main"><span className="eyebrow">{snapshot && lastKnownBalance ? 'Last known balance' : 'Total balance'}</span><div className={`balance-number ${balances ? '' : 'balance-unknown'}`} data-testid="balance-total" aria-label={balances ? undefined : 'Total balance is loading'}>{totalBalance === null ? '—' : formatTsc(totalBalance)}<span>TSC</span></div><p className="balance-meta">{snapshot ? <>{lastKnownBalance ? 'Last verified' : 'Updated'} <time dateTime={cachedDisplay?.verifiedAt ?? snapshot.observedAt} title={new Date(cachedDisplay?.verifiedAt ?? snapshot.observedAt).toLocaleString()}>{formatUpdatedAt(cachedDisplay?.verifiedAt ?? snapshot.observedAt)}</time></> : 'Checking balance…'}</p></div>
            <div className="balance-actions"><button className="button primary" onClick={() => setTab('send')} disabled={busy || !canSend}><Icon name="arrow-up" />Send</button><button className="button secondary" onClick={() => setTab('receive')} disabled={busy || !receive}><Icon name="arrow-down" />Receive</button></div><div className="balance-details"><div><span>Available</span><strong data-testid="balance-available">{balances ? formatTsc(balances.spendable) : '—'} TSC</strong></div><div><span>Pending</span><strong data-testid="balance-pending">{balances ? formatTsc(balances.pending) : '—'} TSC</strong></div>{balances && balances.unsupported > 0n && <div className="balance-unsupported" title="Unverified or unsupported funds are excluded from the total balance."><span>Unverified funds</span><strong data-testid="balance-unsupported">{formatTsc(balances.unsupported)} TSC</strong></div>}</div>{snapshot && <><BalanceDetails snapshot={snapshot} ownedAddresses={ownedAddresses} cached={snapshotCached} stale={!syncTrusted} /><NetworkDetails network={snapshot.network} /></>}</section>
          <section className="card history-card"><div className="section-heading"><h2>{cachedDisplay?.historyTruncated ? 'Recent activity' : 'Activity'}</h2><span className="muted">{snapshot ? `${snapshot.history.length} ${cachedDisplay?.historyTruncated ? 'recent ' : ''}${snapshot.history.length === 1 ? 'transaction' : 'transactions'}` : 'Loading activity'}</span></div>
            {!snapshot?.history.length ? <div className="empty-state"><Icon name="wallet" size={32} /><h3>{snapshot ? 'No activity yet' : 'Checking your activity'}</h3><p>Your received and sent transactions will appear here.</p>{receive && <button className="button text" onClick={() => setTab('receive')}>Receive your first payment →</button>}</div>
              : <div className="history-list">{snapshot.history.map(entry => <ActivityRow key={entry.txid} entry={entry} network={snapshot.network} />)}</div>}</section>
        </>}
        {tab === 'receive' && <section className="card action-card receive-card"><span className="eyebrow">Receive TensorCash</span><h2>Your receive address</h2><p className="muted">Send only native TSC on {metadata?.network === 'regtest' ? 'this regtest network' : 'TensorCash mainnet'} to this address.</p>{receive ? <><div className="qr-frame">{qr ? <img src={qr} alt="QR code for your TensorCash receive address" width="240" height="240" /> : <span className="muted">Preparing QR…</span>}</div><label className="field"><span>Full address</span><div className="address-box mono">{receive.address}</div></label><div className="button-row"><button className="button primary" onClick={copyAddress} disabled={busy}><Icon name="copy" />Copy address</button><button className="button secondary" onClick={freshAddress} disabled={busy}>New address</button></div><p className="footnote">A fresh address helps protect your privacy. All previous receive addresses remain yours.</p></> : <div className="empty-state"><p>Synchronize your wallet to load a receive address.</p><button className="button secondary" onClick={refresh} disabled={busy}>Synchronize</button></div>}</section>}
        {tab === 'send' && <section className="card action-card send-card">{receipt ? <><div className="receipt-icon"><Icon name="check" size={30} /></div><span className="eyebrow">Transaction published</span><h2>On its way.</h2><dl className="review-list"><div><dt>Transaction ID</dt><dd className="mono break">{receipt.txid}</dd></div><div><dt>Final network fee</dt><dd>{formatTsc(receipt.feeUnits)} TSC</dd></div>{receiptConfirmation && <div><dt>{receiptConfirmation.label}</dt><dd>{receiptConfirmation.progress}</dd></div>}</dl>{receiptConfirmation?.estimate && <p className="receipt-estimate" title="Estimated from recent blocks. Network conditions can change the wait.">{receiptConfirmation.estimate}</p>}{receiptLink && <a className="button secondary full explorer-button" href={receiptLink} target="_blank" rel="noopener noreferrer">View transaction in explorer ↗</a>}<p className="receipt-next">{canSend ? `Available for another payment: ${formatTsc(balances!.spendable)} TSC.` : lastKnownBalance ? 'Refresh the wallet to check your remaining available funds.' : syncing || awaitingReconciliation ? 'Checking your remaining funds…' : balances && balances.pending > 0n ? 'Your remaining funds are waiting for confirmations.' : 'No available funds remain.'}</p>{balances && balances.spendable > 0n && <button className="button primary full" disabled={busy || !canSend} onClick={() => { setReceipt(null); setError(''); }}>Send another</button>}<button className="button secondary full receipt-activity" onClick={() => { setReceipt(null); setTab('overview'); }}>View activity</button></>
          : plan ? <>
            <span className="eyebrow">Review transfer</span>
            <h2>Check every detail.</h2>
            <p className="muted">Your device will sign exactly this transfer after you confirm.</p>
            <dl className="review-list">
              <div><dt>To</dt><dd className="mono break">{plan.recipient}</dd></div>
              <div><dt>Amount</dt><dd className="review-amount">{formatTsc(plan.amountUnits)} TSC</dd></div>
              <div><dt>Network fee</dt><dd>{formatTsc(plan.feeUnits)} TSC</dd></div>
              <div><dt>Total</dt><dd>{formatTsc(BigInt(plan.amountUnits) + BigInt(plan.feeUnits))} TSC</dd></div>
              <div><dt>Funds used</dt><dd>{plan.inputCount} {plan.inputCount === 1 ? 'UTXO' : 'UTXOs'}</dd></div>
              <div><dt>Network</dt><dd>{metadata?.network === 'regtest' ? 'Regtest · test coins' : 'TensorCash mainnet'}</dd></div>
              {BigInt(plan.changeUnits) > 0n && <div><dt>Change back to your wallet</dt><dd>{formatTsc(plan.changeUnits)} TSC</dd></div>}
              {signed && <div><dt>Transaction ID</dt><dd className="mono break">{signed.txid}</dd></div>}
            </dl>
            {retryRequired && <div className="callout warning">The transaction may already be known to the network. Retry checks and publishes the exact same signed transaction.</div>}
            {discardAllowed && <div className="callout">The node rejected this transfer and its inputs remain unspent. You can cancel it after one more network check.</div>}
            <button className="button primary full" disabled={busy} onClick={publish}>{retryRequired ? 'Check & retry same transaction' : 'Confirm & send'}<Icon name="arrow-up" /></button>
            {discardAllowed && <button className="button secondary full" disabled={busy} onClick={discardRejectedTransfer}>Cancel rejected transfer</button>}
            <button className="button text full" disabled={busy} onClick={cancelTransfer}>{signed ? 'View activity · keep saved transfer' : 'Back to edit'}</button>
          </>
          : <>
            <span className="eyebrow">Send TensorCash</span><h2>Make a transfer.</h2>
            <div className="send-balance"><span>{lastKnownBalance ? 'Last known available' : 'Available'}</span><strong data-testid="send-available-balance">{balances ? formatTsc(balances.spendable) : '—'} <span>TSC</span></strong></div>
            {!lastKnownBalance && balances && balances.pending > 0n && <p className="utxo-help">{balances.spendable > 0n ? 'You can send available funds while other payments wait for confirmation.' : `Pending funds need ${snapshot!.network.minConfirmations} confirmations before you can spend them.`}</p>}
            <p className="utxo-help">Available UTXOs are combined automatically when needed. Max sends all available funds minus the network fee.</p>
            <form onSubmit={prepareSend}>
              <Field label="Recipient address"><input name="recipient" value={sendRecipient} onChange={event => setSendRecipient(event.target.value)} disabled={busy} required spellCheck={false} autoComplete="off" autoCapitalize="none" placeholder={metadata?.network === 'regtest' ? 'Regtest TensorCash address' : 'tc1…'} maxLength={150} /></Field>
              <Field label="Amount · TSC" action={<button className="button secondary amount-max" type="button" onClick={fillSendMax} disabled={busy || !canSend || !maxQuote} aria-pressed={sendMax} title="Available balance minus the network fee">Max</button>}>
                <input name="amount" inputMode="decimal" value={sendAmountValue} onChange={event => { setSendMax(false); setSendAmount(event.target.value); }} required disabled={busy} placeholder="0.00" autoComplete="off" />
              </Field>
              {sendMax && maxQuote && <p className="max-fee" data-testid="max-network-fee">Network fee: {formatTsc(maxQuote.feeUnits)} TSC</p>}
              <Field label="Network fee rate · atomic units/vbyte" hint={fees ? `Suggested: ${ceilRate(fees.suggestedRate)} · 100,000,000 atomic units = 1 TSC` : 'Fee recommendations are loading.'}><input name="feeRate" inputMode="numeric" pattern="[1-9][0-9]*" value={feeRate} onChange={event => setFeeRate(event.target.value)} disabled={busy} required /></Field>
              <button className="button primary full" disabled={busy || !canSend || (sendMax && !maxQuote)}>Review transfer <span>→</span></button>
            </form>
            <p className="footnote">The network fee is paid to miners. Transfers cannot be reversed.</p>
          </>}</section>}
        {tab === 'settings' && <section className="card action-card settings-card"><span className="eyebrow">Wallet settings</span><h2>Keep your wallet safe.</h2>{settingsMode === 'menu' ? <><p className="muted">Your keys stay on this device. Keep a separate backup to protect against loss.</p><div className="settings-list"><button onClick={() => setSettingsMode('export')}><span><strong>Download encrypted backup</strong><small>Password protected JSON file</small></span><span>→</span></button><button onClick={() => setSettingsMode('reveal')}><span><strong>View recovery phrase</strong><small>Requires your wallet password</small></span><span>→</span></button><button onClick={() => setSettingsMode('password')}><span><strong>Change wallet password</strong><small>Update encryption on this device</small></span><span>→</span></button><button className="danger" onClick={() => setSettingsMode('reset')}><span><strong>Remove wallet from this device</strong><small>Your funds remain on the network</small></span><span>→</span></button></div><dl className="settings-info"><div><dt>Network</dt><dd>{metadata?.network}</dd></div><div><dt>Backup</dt><dd>Recovery phrase confirmed</dd></div><div><dt>Auto-lock</dt><dd>5 minutes without activity</dd></div><div><dt>Derivation</dt><dd className="mono">{metadata?.accountPath}</dd></div></dl></>
          : <><button className="back-link" disabled={busy} onClick={() => setSettingsMode('menu')}>← Back to settings</button>{settingsMode === 'export' ? <form onSubmit={exportWallet}><p className="muted">This file contains your encrypted wallet. Its current password is required to restore it.</p><PasswordField /><button className="button primary full" disabled={busy}>Download encrypted backup</button></form>
          : settingsMode === 'reveal' ? <form onSubmit={revealSeed}><p className="muted">Anyone with your recovery phrase can spend your funds. Make sure your screen is private.</p><PasswordField /><button className="button primary full" disabled={busy}>Show recovery phrase</button></form>
          : settingsMode === 'password' ? <form onSubmit={changePassword}><PasswordField name="currentPassword" label="Current password" /><PasswordField name="newPassword" label="New password" confirm /><PasswordField name="confirmPassword" label="Confirm new password" confirm /><button className="button primary full" disabled={busy}>Change password</button></form>
          : <form onSubmit={resetWallet}><div className="callout warning">This permanently removes the local wallet. Make sure you have your recovery phrase or an encrypted backup and its password before continuing.</div><PasswordField /><Field label="Type REMOVE WALLET to confirm"><input name="confirmation" required autoComplete="off" spellCheck={false} /></Field><button className="button destructive full" disabled={busy}>Remove local wallet</button></form>}</>}</section>}
      </>}
    </main><footer className="site-footer"><span className="footer-brand"><img src="/brand/logo.svg" alt="" width="22" height="22" /><span className="brand-wordmark">TensorCash<span className="brand-subtitle">wallet</span></span></span><span>Local keys · Keep your recovery phrase offline</span></footer>
  </>;
}
