import type { AddressRecord, HistoryEntry, WalletEngine, WalletSnapshot } from '../shared/types';
import type { ChainProvider } from './client';
import { assertNetworkInfo } from './client';

const GAP = 20;
const MAX_BRANCH = 200;
const INITIAL_PER_BRANCH = 25;
const ROUND_PER_BRANCH = 50;
const hash = /^[a-f0-9]{64}$/;
const outpoint = (txid: string, vout: number) => `${txid}:${vout}`;
export interface DiscoveredWallet {
  snapshot: WalletSnapshot; receive: AddressRecord; change: AddressRecord;
  ownedAddresses: AddressRecord[];
}
function validateCursor(index: number) {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_BRANCH - GAP)
    throw new Error('The saved receive cursor exceeds the supported recovery range.');
}
async function retry(operation: () => Promise<DiscoveredWallet>, progress?: (message: string) => void) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await operation(); }
    catch (error) {
      const message = error instanceof Error ? error.message : '';
      const race = /pending transfers changed|mempool changed|index changed during synchronization|chain tip changed|confirmation state changed/i.test(message);
      if (!race || attempt === 2) throw error;
      progress?.('The network changed. Rechecking a consistent wallet view…');
      await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
  throw new Error('Wallet synchronization could not complete.');
}
export async function discoverWallet(
  engine: WalletEngine, provider: ChainProvider, onProgress?: (message: string) => void,
  minimumReceiveIndex = 0,
): Promise<DiscoveredWallet> {
  validateCursor(minimumReceiveIndex);
  return retry(() => discoverOnce(engine, provider, onProgress, minimumReceiveIndex), onProgress);
}

class SnapshotRead {
  private tip = ''; private mempool = '';
  private batches: WalletSnapshot[] = [];
  async add(provider: ChainProvider, records: AddressRecord[], network: WalletSnapshot['network']['network']) {
    const snapshot = await provider.sync(records.map(record => record.address));
    assertNetworkInfo(snapshot.network);
    if (snapshot.network.network !== network) throw new Error('The provider changed networks during discovery.');
    if (!snapshot.complete) throw new Error(snapshot.warnings[0] || 'Address history is incomplete. Retry synchronization.');
    const requested = new Map(records.map(record => [record.address, record]));
    if (requested.size !== records.length || snapshot.addresses.length !== records.length ||
        new Set(snapshot.addresses.map(item => item.address)).size !== records.length ||
        snapshot.addresses.some(item => !requested.has(item.address))) throw new Error('The provider omitted requested addresses.');
    if (typeof snapshot.mempoolFingerprint !== 'string' || !hash.test(snapshot.mempoolFingerprint))
      throw new Error('The provider omitted its mempool consistency checkpoint.');
    if (!this.tip) { this.tip = snapshot.network.tipHash; this.mempool = snapshot.mempoolFingerprint; }
    else if (this.tip !== snapshot.network.tipHash || this.mempool !== snapshot.mempoolFingerprint)
      throw new Error('The chain tip or pending transfers changed during synchronization. Refresh again.');
    const used = new Map(snapshot.addresses.map(item => [item.address, item.used]));
    const history = new Map(snapshot.history.map(entry => [entry.txid, entry]));
    if (history.size !== snapshot.history.length) throw new Error('The provider returned duplicate transaction history.');
    const coins = new Set<string>();
    for (const coin of snapshot.utxos) {
      const record = requested.get(coin.address);
      if (!record || record.scriptHex !== coin.scriptHex || !used.get(coin.address))
        throw new Error('The provider returned an output outside the requested used addresses.');
      const item = history.get(coin.txid);
      if (!item || item.status === 'conflicted' || item.confirmations !== coin.confirmations || item.blockHeight !== coin.blockHeight)
        throw new Error('UTXO and transaction confirmation state changed during discovery.');
      const key = outpoint(coin.txid, coin.vout);
      if (coins.has(key)) throw new Error('The provider returned duplicate outputs.');
      coins.add(key);
    }
    this.batches.push(structuredClone(snapshot));
    return snapshot;
  }
  async finish(provider: ChainProvider): Promise<WalletSnapshot> {
    const current = await provider.network(); assertNetworkInfo(current);
    const last = this.batches.at(-1);
    if (!last) throw new Error('No complete wallet view was read');
    if (current.network !== last.network.network || current.tipHash !== this.tip)
      throw new Error('The chain tip changed during synchronization. Refresh again.');
    const history = new Map<string, HistoryEntry>();
    const utxos = new Map<string, WalletSnapshot['utxos'][number]>();
    const edges = new Map<string, NonNullable<WalletSnapshot['spentOutpoints']>[number]>();
    for (const batch of this.batches) {
      for (const entry of batch.history) {
        const existing = history.get(entry.txid);
        if (existing) {
          if (existing.status !== entry.status || existing.blockHeight !== entry.blockHeight || existing.confirmations !== entry.confirmations)
            throw new Error('Transaction confirmation state changed during discovery.');
          if (existing.feeUnits !== entry.feeUnits || existing.timestamp !== entry.timestamp)
            throw new Error('The provider returned conflicting transaction history.');
          existing.deltaUnits = (BigInt(existing.deltaUnits) + BigInt(entry.deltaUnits)).toString();
        } else history.set(entry.txid, { ...entry });
      }
      for (const coin of batch.utxos) {
        const key = outpoint(coin.txid, coin.vout);
        if (utxos.has(key)) throw new Error('The provider returned duplicate outputs across address batches.');
        utxos.set(key, coin);
      }
      for (const edge of batch.spentOutpoints ?? []) {
        const key = outpoint(edge.txid, edge.vout); const existing = edges.get(key);
        if (existing && existing.spentByTxid !== edge.spentByTxid) throw new Error('The provider returned conflicting output spends.');
        edges.set(key, edge);
      }
    }
    for (const [key, edge] of edges) {
      const entry = history.get(edge.spentByTxid);
      if (!entry || entry.status === 'conflicted') throw new Error('The provider returned an uncorroborated output spend.');
      if (utxos.has(key)) throw new Error('The provider returned an output as both current and spent.');
    }
    return {
      network: last.network, addresses: this.batches.flatMap(batch => batch.addresses),
      utxos: [...utxos.values()], history: [...history.values()].sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0) || a.txid.localeCompare(b.txid)),
      complete: true, warnings: [...new Set(this.batches.flatMap(batch => batch.warnings))],
      observedAt: last.observedAt, mempoolFingerprint: this.mempool,
      spentOutpoints: [...edges.values()],
    };
  }
}

function positions(records: AddressRecord[], snapshot: WalletSnapshot, minimumReceiveIndex: number) {
  const used = new Set(snapshot.addresses.filter(item => item.used).map(item => item.address));
  const lastUsed = [-1, -1]; const maximum = [-1, -1];
  for (const record of records) { maximum[record.branch] = Math.max(maximum[record.branch], record.index); if (used.has(record.address)) lastUsed[record.branch] = Math.max(lastUsed[record.branch], record.index); }
  const maximumIssuedIndex = MAX_BRANCH - GAP - 1;
  if (lastUsed.some(index => index > maximumIssuedIndex))
    throw new Error('This wallet uses addresses outside the supported recovery range. Use an archival recovery tool before sending.');
  const finished = lastUsed.map((last, branch) => maximum[branch] - last >= GAP && (branch !== 0 || maximum[0] >= minimumReceiveIndex));
  const receiveIndex = Math.min(Math.max(lastUsed[0] + 1, minimumReceiveIndex), maximumIssuedIndex);
  const changeIndex = Math.min(lastUsed[1] + 1, maximumIssuedIndex);
  return { lastUsed, maximum, finished, receiveIndex, changeIndex };
}
function result(records: AddressRecord[], snapshot: WalletSnapshot, minimumReceiveIndex: number): DiscoveredWallet {
  const state = positions(records, snapshot, minimumReceiveIndex);
  const receive = records.find(record => record.branch === 0 && record.index === state.receiveIndex);
  const change = records.find(record => record.branch === 1 && record.index === state.changeIndex);
  if (!receive || !change || state.finished.some(value => !value)) throw new Error('Recovery reached the address scan limit. Use an archival recovery tool before sending.');
  if (state.lastUsed.some(index => index === MAX_BRANCH - GAP - 1)) snapshot.warnings = [...new Set([...snapshot.warnings,
    'Address range reached. Existing terminal addresses are reused so this wallet remains recoverable.'])];
  return { receive, change, ownedAddresses: records, snapshot };
}
async function initial(engine: WalletEngine, provider: ChainProvider) {
  const metadata = await engine.getMetadata(); if (!metadata) throw new Error('Create or unlock your wallet first.');
  const network = await provider.network(); assertNetworkInfo(network);
  if (metadata.network !== network.network) throw new Error('This wallet belongs to another network.');
  return metadata.network;
}
async function discoverOnce(engine: WalletEngine, provider: ChainProvider, progress: ((message: string) => void) | undefined, minimumReceiveIndex: number) {
  const network = await initial(engine, provider); const read = new SnapshotRead();
  const records: AddressRecord[] = []; const finished = [false, false]; const lastUsed = [-1, -1];
  for (let start = 0; start < MAX_BRANCH;) {
    const count = Math.min(start === 0 ? INITIAL_PER_BRANCH : ROUND_PER_BRANCH, MAX_BRANCH - start);
    const chunk: AddressRecord[] = [];
    for (const branch of [0, 1] as const) if (!finished[branch]) {
      progress?.(`Discovering ${branch === 0 ? 'receive' : 'change'} addresses ${start + 1}–${start + count}…`);
      chunk.push(...await engine.getAddresses(branch, start, count));
    }
    if (!chunk.length) break;
    const batch = await read.add(provider, chunk, network); records.push(...chunk);
    const used = new Set(batch.addresses.filter(item => item.used).map(item => item.address));
    for (const record of chunk) if (used.has(record.address)) lastUsed[record.branch] = record.index;
    for (const branch of [0, 1] as const) if (!finished[branch])
      finished[branch] = start + count - 1 - lastUsed[branch] >= GAP && (branch !== 0 || start + count - 1 >= minimumReceiveIndex);
    if (finished.every(Boolean)) break;
    start += count;
  }
  if (finished.some(value => !value)) throw new Error('Recovery reached the address scan limit. Use an archival recovery tool before sending.');
  const snapshot = await read.finish(provider); progress?.('Wallet synchronized');
  return result(records, snapshot, minimumReceiveIndex);
}

export async function refreshKnownWallet(
  engine: WalletEngine, provider: ChainProvider, known: DiscoveredWallet, onProgress?: (message: string) => void,
  minimumReceiveIndex = 0,
): Promise<DiscoveredWallet> {
  validateCursor(minimumReceiveIndex);
  return retry(async () => {
    const network = await initial(engine, provider);
    if (known.snapshot.network.network !== network) throw new Error('Known wallet view belongs to another network');
    const records = [...known.ownedAddresses].sort((a, b) => a.branch - b.branch || a.index - b.index);
    if (!records.length || records.length > MAX_BRANCH * 2 || new Set(records.map(record => record.address)).size !== records.length)
      throw new Error('Known address range is invalid');
    for (const branch of [0, 1] as const) {
      const branchRecords = records.filter(record => record.branch === branch);
      if (!branchRecords.length || branchRecords.some((record, index) => record.index !== index) || branchRecords.length > MAX_BRANCH)
        throw new Error('Known address range is incomplete');
    }
    const read = new SnapshotRead();
    for (let start = 0; start < records.length; start += 100) {
      onProgress?.('Refreshing known addresses and pending transfers…');
      await read.add(provider, records.slice(start, start + 100), network);
    }
    const snapshot = await read.finish(provider);
    if (positions(records, snapshot, minimumReceiveIndex).finished.some(value => !value))
      return discoverOnce(engine, provider, onProgress, minimumReceiveIndex);
    onProgress?.('Wallet synchronized');
    return result(records, snapshot, minimumReceiveIndex);
  }, onProgress);
}
