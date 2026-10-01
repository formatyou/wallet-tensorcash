import { createHash } from 'node:crypto';
import type { FeePolicy, HistoryEntry, NetworkInfo, NetworkReadinessReason, Utxo, WalletSnapshot, ValidationResult, BroadcastResult } from '../src/shared/types';
import { decodeNativeTransaction, type NativeTransaction } from '../src/core/raw';
import type { ResolvedConfig } from './config';
import type { Rpc } from './rpc';
import { readBounded } from './rpc';
import { GatewayError, RpcError, ensure } from './errors';
import { indexSupportsAcceptedTip } from './index-readiness';
import { array, atomic, coinUnits, feeRate, hash, integer, mapBounded, record, script, type RecordData } from './data';

interface Candidate {
  txid: string; vout: number; address: string; scriptHex: string; amount: bigint;
  blockHeight: number | null; blockHash?: string; coinbase: boolean;
}
type SpentOutpoint = NonNullable<WalletSnapshot['spentOutpoints']>[number];
interface Collection { candidates: Candidate[]; history: HistoryEntry[]; used: Set<string>; complete: boolean; warnings: string[]; ownedOutpoints: Map<string, Candidate>; spentOutpoints: SpentOutpoint[]; }
interface NativeParent { rawHex: string; decoded: NativeTransaction; }
interface MempoolTransaction { txid: string; rawHex: string; inputs: { txid: string; vout: number }[]; outputs: { scriptHex: string; amount: bigint; vout: number }[]; }
type BlockTiming = Pick<NetworkInfo, 'averageBlockSeconds' | 'blockTimeSampleSize'>;
const iso = () => new Date().toISOString();
const key = (txid: string, vout: number) => `${txid}:${vout}`;
const P2WPKH = /^0014[0-9a-f]{40}$/;
const MAX_SPEND_EDGES = 100000;
function appendSpendEdges(target: SpentOutpoint[], seen: Set<string>, txid: string, inputs: { txid: string; vout: number }[]): boolean {
  let complete = true;
  for (const input of inputs) {
    const id = `${key(input.txid, input.vout)}:${txid}`; if (seen.has(id)) continue;
    if (target.length >= MAX_SPEND_EDGES) { complete = false; continue; }
    seen.add(id); target.push({ txid: input.txid, vout: input.vout, spentByTxid: txid });
  }
  return complete;
}

export class Gateway {
  private readonly rawCache = new Map<string, string>();
  private rawCacheCharacters = 0;
  private readonly rawFlights = new Map<string, Promise<string>>();
  private readonly nativeFlights = new Map<string, Promise<NativeParent>>();
  private readonly mempoolCache = new Map<string, MempoolTransaction>();
  private readonly mempoolFlights = new Map<string, Promise<MempoolTransaction>>();
  private mempoolCacheCharacters = 0;
  private readonly blockTimingCache = new Map<string, BlockTiming>();
  private readonly blockTimingFlights = new Map<string, Promise<BlockTiming>>();
  private watchQueue: Promise<unknown> = Promise.resolve();
  constructor(readonly config: ResolvedConfig, readonly rpc: Rpc) {}

  private async publicGet(path: string, seed = false): Promise<unknown> {
    const url = new URL(path, `${(seed ? this.config.seedUrl : this.config.explorerUrl).replace(/\/$/, '')}/`);
    let response: Response;
    try { response = await (this.config.fetch || fetch)(url, { headers: { Accept: 'application/json, text/plain' }, signal: AbortSignal.timeout(this.config.requestTimeoutMs), redirect: 'error' }); }
    catch { throw new GatewayError('index-unavailable', 'Public chain provider is unavailable'); }
    if (response.status === 404) throw new GatewayError('not-found', 'Requested chain data is unavailable', 404);
    if (!response.ok) throw new GatewayError('index-unavailable', 'Public chain provider is unavailable');
    const text = await readBounded(response);
    try { return JSON.parse(text); } catch { if (seed) return text.trim(); throw new GatewayError('invalid-provider-data', 'Public chain provider returned invalid JSON'); }
  }

  async network(): Promise<NetworkInfo> {
    const info = record(await this.rpc.call('getblockchaininfo'));
    const expectedChain = this.config.network === 'mainnet' ? 'tensor' : 'regtest';
    ensure(info.chain === expectedChain, 'Core network does not match wallet network');
    const genesisHash = hash(await this.rpc.call('getblockhash', [0]));
    ensure(genesisHash === this.config.expectedGenesis, 'Core genesis does not match wallet network');
    const height = integer(info.blocks); const headers = integer(info.headers); const tipHash = hash(info.bestblockhash);
    const header = record(await this.rpc.call('getblockheader', [tipHash]));
    const tipTime = integer(header.time); const now = Math.floor(Date.now() / 1000);
    // New headers do not invalidate Core's already accepted chain. Use only
    // that accepted tip, still requiring the explorer to be ready on its exact
    // height/hash before exposing balances or validating any spend.
    let ready = info.initialblockdownload === false && headers >= height && tipTime <= now + 7200 && now - tipTime <= this.config.maxTipAgeSeconds;
    let readinessReason: NetworkReadinessReason | undefined;
    if (info.initialblockdownload !== false) readinessReason = 'node-sync';
    else if (headers < height) readinessReason = 'node-sync';
    else if (!ready) readinessReason = 'stale-data';
    let indexedHeight = height;
    if (this.config.network === 'mainnet') {
      try { const index = record(await this.publicGet('/api/status'));
        indexedHeight = integer(index.indexed_height);
        const lag = integer(index.lag_blocks); const indexedTip = hash(index.indexed_tip); const checked = integer(index.checked_at);
        const indexReady = indexSupportsAcceptedTip(index, { height, hash: tipHash, headers }, now, this.config.maxTipAgeSeconds);
        const indexFresh = Math.abs(now - checked) <= 30;
        if (!readinessReason) {
          if (index.core_online !== true) readinessReason = 'index-unavailable';
          else if (index.initial_block_download !== false) readinessReason = 'node-sync';
          else if (!indexFresh) readinessReason = 'stale-data';
          else if (!indexReady) readinessReason = headers > height && index.ready !== true && lag === 0 && indexedHeight === height && indexedTip === tipHash ? 'block-validation' : 'index-sync';
        }
        ready = ready && indexReady && indexFresh;
      } catch { ready = false; indexedHeight = 0; readinessReason ??= 'index-unavailable'; }
    }
    const timing = this.config.network === 'mainnet' ? await this.recentBlockTiming(height, tipHash, tipTime) : {};
    return { network: this.config.network, chain: expectedChain, genesisHash, height, tipHash, indexedHeight, ready, observedAt: iso(), explorerUrl: this.config.network === 'mainnet' ? this.config.explorerUrl : null, minConfirmations: this.config.minConfirmations, coinbaseMaturity: this.config.coinbaseMaturity, ...(headers > height ? { pendingValidationBlocks: headers - height } : {}), ...(readinessReason ? { readinessReason } : {}), ...(tipTime > 0 ? { lastBlockTime: tipTime } : {}), ...timing };
  }

  private async recentBlockTiming(height: number, tipHash: string, tipTime: number): Promise<BlockTiming> {
    const cached = this.blockTimingCache.get(tipHash); if (cached) return cached;
    const existing = this.blockTimingFlights.get(tipHash); if (existing) return existing;
    const pending = (async (): Promise<BlockTiming> => {
      let result: BlockTiming = {};
      try {
        const intervals = Math.min(20, height); ensure(intervals > 0 && tipTime > 0);
        const previousHash = hash(await this.rpc.call('getblockhash', [height - intervals]));
        const previous = record(await this.rpc.call('getblockheader', [previousHash]));
        const previousTime = integer(previous.time, 1);
        ensure(previous.hash === previousHash && integer(previous.height) === height - intervals);
        const average = (tipTime - previousTime) / intervals;
        ensure(Number.isFinite(average) && average > 0 && average <= 86400);
        // The arithmetic mean of consecutive intervals telescopes to these two
        // timestamps; no individual-interval clipping silently biases it.
        ensure(hash(await this.rpc.call('getblockhash', [height])) === tipHash, 'Chain tip changed during block timing estimate');
        result = { averageBlockSeconds: average, blockTimeSampleSize: intervals };
      } catch { /* Optional timing never changes the network's readiness verdict. */ }
      while (this.blockTimingCache.size >= 8) this.blockTimingCache.delete(this.blockTimingCache.keys().next().value!);
      this.blockTimingCache.set(tipHash, result); return result;
    })();
    this.blockTimingFlights.set(tipHash, pending);
    try { return await pending; } finally { this.blockTimingFlights.delete(tipHash); }
  }

  private async requireReady(): Promise<NetworkInfo> {
    const network = await this.network();
    if (!network.ready) throw new GatewayError('network-not-ready', 'Chain data is not synchronized or fresh');
    return network;
  }

  private async mempoolSnapshot(): Promise<{ ids: string[]; fingerprint: string }> {
    const ids = array(await this.rpc.call('getrawmempool'), 100000).map(hash).sort();
    ensure(new Set(ids).size === ids.length);
    return { ids, fingerprint: createHash('sha256').update(ids.join('\n')).digest('hex') };
  }
  private async mempoolFingerprint(): Promise<string> { return (await this.mempoolSnapshot()).fingerprint; }

  private async validateAddresses(addresses: string[]): Promise<Map<string, string>> {
    const values = await mapBounded(addresses, async address => {
      const prefix = this.config.network === 'mainnet' ? 'tc1q' : 'bcrt1q';
      if (!address.startsWith(prefix) || !/^[a-z0-9]{14,100}$/.test(address)) throw new GatewayError('invalid-address', 'Only wallet-network P2WPKH addresses are supported', 400);
      const decoded = record(await this.rpc.call('validateaddress', [address]));
      if (decoded.isvalid !== true || (decoded.address !== undefined && decoded.address !== address)) throw new GatewayError('invalid-address', 'Invalid wallet-network address', 400);
      const scriptHex = script(decoded.scriptPubKey);
      if (!P2WPKH.test(scriptHex)) throw new GatewayError('invalid-address', 'Only P2WPKH addresses are supported', 400);
      return [scriptHex, address] as const;
    });
    ensure(new Set(values.map(v => v[0])).size === values.length, 'Duplicate address script');
    return new Map(values);
  }

  private rememberRaw(txid: string, rawHex: string): void {
    const previous = this.rawCache.get(txid);
    if (previous) { this.rawCacheCharacters -= previous.length; this.rawCache.delete(txid); }
    while (this.rawCache.size >= 256 || this.rawCacheCharacters + rawHex.length > 16_000_000) {
      const oldest = this.rawCache.keys().next().value; if (!oldest) break;
      this.rawCacheCharacters -= this.rawCache.get(oldest)!.length; this.rawCache.delete(oldest);
    }
    this.rawCacheCharacters += rawHex.length;
    this.rawCache.set(txid, rawHex);
  }

  async raw(txid: string, blockHash?: string): Promise<string> {
    if (this.rawCache.has(txid)) return this.rawCache.get(txid)!;
    if (this.rawFlights.has(txid)) return this.rawFlights.get(txid)!;
    const pending = this.loadRaw(txid, blockHash); this.rawFlights.set(txid, pending);
    try { return await pending; } finally { this.rawFlights.delete(txid); }
  }
  private async loadRaw(txid: string, blockHash?: string): Promise<string> {
    let raw: unknown;
    try { raw = await this.rpc.call('getrawtransaction', blockHash ? [txid, false, blockHash] : [txid, false]); } catch (error) {
      if (!(error instanceof RpcError) || ![-1, -5].includes(error.code)) throw error;
    }
    if (typeof raw !== 'string' && this.config.network === 'regtest') {
      try { raw = record(await this.rpc.call('gettransaction', [txid, true], this.config.watchWallet)).hex; } catch (error) {
        if (!(error instanceof RpcError) || ![-5, -18].includes(error.code)) throw error;
      }
    }
    if (typeof raw !== 'string' && this.config.network === 'mainnet') {
      if (!blockHash) {
        try { const tx = record(record(await this.publicGet(`/api/tx/${txid}`)).transaction);
          if (tx.block_hash != null) { const candidateHash = hash(tx.block_hash); const height = integer(tx.block_height);
            if (hash(await this.rpc.call('getblockhash', [height])) === candidateHash) {
              try { raw = await this.rpc.call('getrawtransaction', [txid, false, candidateHash]); } catch (error) { if (!(error instanceof RpcError) || ![-1, -5].includes(error.code)) throw error; }
            }
          }
        } catch (error) { if (error instanceof GatewayError && error.code === 'rpc-unavailable') throw error; }
      }
      if (typeof raw !== 'string') raw = await this.publicGet(`/api/tx/${txid}/hex`, true);
    }
    if (typeof raw !== 'string' || raw.length < 20 || raw.length > 2_000_000 || raw.length % 2 || !/^[0-9a-f]+$/i.test(raw)) throw new GatewayError('raw-unavailable', 'Parent transaction raw data is unavailable', 404);
    let decoded: NativeTransaction;
    try { decoded = decodeNativeTransaction(raw); } catch { throw new GatewayError('unsupported-transaction', 'Transaction format is unsupported', 422); }
    ensure(decoded.txid === txid, 'Raw transaction identity mismatch');
    this.rememberRaw(txid, raw.toLowerCase()); return raw.toLowerCase();
  }

  private async nativeParent(txid: string, blockHash?: string): Promise<NativeParent> {
    if (this.nativeFlights.has(txid)) return this.nativeFlights.get(txid)!;
    const pending = this.loadNativeParent(txid, blockHash); this.nativeFlights.set(txid, pending);
    try { return await pending; } finally { this.nativeFlights.delete(txid); }
  }
  private async loadNativeParent(txid: string, blockHash?: string): Promise<NativeParent> {
    const rawHex = await this.raw(txid, blockHash); const decoded = decodeNativeTransaction(rawHex);
    const asset = record(await this.rpc.call('decodeassettransaction', [rawHex, false]));
    const summary = record(asset.asset_summary);
    if (summary.has_assets !== false || summary.has_icu !== false) throw new GatewayError('unsupported-transaction', 'Assets and ICU transactions are unsupported', 422);
    if (asset.txid !== undefined) ensure(asset.txid === txid, 'Core transaction decoder identity mismatch');
    const outputs = array(asset.vout, 2000); ensure(outputs.length === decoded.outputs.length, 'Core transaction decoder output mismatch');
    for (let n = 0; n < outputs.length; n++) {
      const output = record(outputs[n]);
      if (Object.keys(output).some(k => !['value', 'n', 'scriptPubKey'].includes(k))) throw new GatewayError('unsupported-transaction', 'Unknown output extensions are unsupported', 422);
      ensure(integer(output.n) === n && coinUnits(output.value) === BigInt(decoded.outputs[n].amountUnits) && script(record(output.scriptPubKey).hex) === decoded.outputs[n].scriptHex, 'Core and local transaction decoders disagree');
    }
    return { rawHex, decoded };
  }

  private async mempoolTransaction(txid: string): Promise<MempoolTransaction> {
    const cached = this.mempoolCache.get(txid); if (cached) return cached;
    const existing = this.mempoolFlights.get(txid); if (existing) return existing;
    const pending = (async () => {
      // Core's verbose decoder also exposes outpoints/scripts for unsupported
      // Tensor extensions. Inspect relevance before applying the native guard:
      // unrelated asset traffic must not block every native wallet.
      const value = record(await this.rpc.call('getrawtransaction', [txid, true]));
      ensure(value.txid === txid && typeof value.hex === 'string' && /^(?:[0-9a-fA-F]{2})+$/.test(value.hex) && value.hex.length <= 2_000_000);
      const rawHex = value.hex.toLowerCase();
      const inputs = array(value.vin, 1000).map(v => { const input = record(v); return { txid: hash(input.txid), vout: integer(input.vout) }; });
      const outputs = array(value.vout, 2000).map((v, n) => { const output = record(v); ensure(integer(output.n) === n); const amount = coinUnits(output.value); ensure(amount >= 0n); return { vout: n, amount, scriptHex: script(record(output.scriptPubKey).hex) }; });
      const result = { txid, rawHex, inputs, outputs };
      while (this.mempoolCache.size >= this.config.maxHistoryTransactions || this.mempoolCacheCharacters + rawHex.length > 16_000_000) {
        const oldest = this.mempoolCache.keys().next().value; if (!oldest) break;
        this.mempoolCacheCharacters -= this.mempoolCache.get(oldest)!.rawHex.length; this.mempoolCache.delete(oldest);
      }
      this.mempoolCache.set(txid, result); this.mempoolCacheCharacters += rawHex.length;
      return result;
    })();
    this.mempoolFlights.set(txid, pending);
    try { return await pending; } finally { this.mempoolFlights.delete(txid); }
  }

  private async overlayMempool(ids: string[], scripts: Map<string, string>, collection: Collection): Promise<void> {
    const mempoolIds = new Set(ids); const hintedPending = new Set(collection.history.filter(h => h.status === 'pending').map(h => h.txid));
    // Pending address-index rows are replaceable hints. Current Core membership
    // and strictly decoded bytes supply the actual delta, outputs and spend graph.
    collection.history = collection.history.filter(h => h.status !== 'pending');
    collection.candidates = collection.candidates.filter(c => c.blockHeight !== null && !mempoolIds.has(c.txid));
    if (ids.length > this.config.maxHistoryTransactions) { collection.complete = false; collection.warnings.push('Core mempool limit reached; pending transfers are incomplete.'); }
    let decodedCharacters = 0; let decodedEdges = 0;
    const transactions = (await mapBounded(ids.slice(0, this.config.maxHistoryTransactions), async txid => {
      try { const tx = await this.mempoolTransaction(txid); decodedCharacters += tx.rawHex.length; decodedEdges += tx.inputs.length + tx.outputs.length;
        if (decodedCharacters > 16_000_000 || decodedEdges > 100000) { collection.complete = false; collection.warnings.push('Core mempool graph limit reached; pending transfers are incomplete.'); return null; }
        return tx; }
      catch { collection.complete = false; collection.warnings.push('Core mempool transaction is unavailable; pending transfers are incomplete.'); return null; }
    })).filter((tx): tx is MempoolTransaction => tx !== null);
    let edges = 0;
    for (const tx of transactions) {
      edges += tx.inputs.length + tx.outputs.length;
      if (edges > 100000) { collection.complete = false; collection.warnings.push('Core mempool graph limit reached; pending transfers are incomplete.'); return; }
      for (const output of tx.outputs) {
        const address = scripts.get(output.scriptHex); if (!address) continue;
        collection.ownedOutpoints.set(key(tx.txid, output.vout), { txid: tx.txid, vout: output.vout, address, scriptHex: output.scriptHex, amount: output.amount, blockHeight: null, coinbase: false });
      }
    }
    const relevant = transactions.filter(tx => hintedPending.has(tx.txid) || tx.outputs.some(o => scripts.has(o.scriptHex)) || tx.inputs.some(i => collection.ownedOutpoints.has(key(i.txid, i.vout))));
    const spendSeen = new Set(collection.spentOutpoints.map(s => `${key(s.txid, s.vout)}:${s.spentByTxid}`));
    const parents = new Map<string, Promise<NativeParent>>(); let prevoutRequests = 0;
    const parent = (txid: string) => {
      if (!parents.has(txid)) {
        if (++prevoutRequests > this.config.maxHistoryTransactions) throw new GatewayError('mempool-prevout-limit', 'Core mempool prevout limit reached');
        const pooled = this.mempoolCache.get(txid);
        if (pooled) this.rememberRaw(txid, pooled.rawHex);
        parents.set(txid, this.nativeParent(txid));
      }
      return parents.get(txid)!;
    };
    await mapBounded(relevant, async value => {
      try {
        this.rememberRaw(value.txid, value.rawHex); const native = await parent(value.txid); const tx = native.decoded;
        ensure(!tx.coinbase && tx.inputs.length === value.inputs.length && tx.outputs.length === value.outputs.length, 'Core mempool raw structure mismatch');
        for (let n = 0; n < tx.inputs.length; n++) ensure(tx.inputs[n].txid === value.inputs[n].txid && tx.inputs[n].vout === value.inputs[n].vout, 'Core mempool raw prevout mismatch');
        for (let n = 0; n < tx.outputs.length; n++) ensure(tx.outputs[n].scriptHex === value.outputs[n].scriptHex && BigInt(tx.outputs[n].amountUnits) === value.outputs[n].amount, 'Core mempool raw output mismatch');
        let received = 0n; let sent = 0n; let inputTotal = 0n;
        const ownedCandidates: Candidate[] = []; const used = new Set<string>();
        for (const output of tx.outputs) {
          const address = scripts.get(output.scriptHex); if (!address) continue;
          used.add(address); received += BigInt(output.amountUnits);
          ownedCandidates.push({ txid: tx.txid, vout: output.vout, address, scriptHex: output.scriptHex, amount: BigInt(output.amountUnits), blockHeight: null, coinbase: false });
        }
        for (const input of tx.inputs) {
          const previous = (await parent(input.txid)).decoded.outputs[input.vout]; ensure(previous, 'Core mempool prevout is unavailable');
          const amount = BigInt(previous.amountUnits); inputTotal += amount;
          const address = scripts.get(previous.scriptHex); if (address) { used.add(address); sent += amount; }
        }
        const fee = inputTotal - tx.outputs.reduce((total, output) => total + BigInt(output.amountUnits), 0n); ensure(fee >= 0n);
        const entry = record(await this.rpc.call('getmempoolentry', [tx.txid])); const timestamp = integer(entry.time);
        // Commit only after all bytes/prevouts have been independently verified.
        for (const address of used) collection.used.add(address);
        collection.history = collection.history.filter(h => h.txid !== tx.txid);
        collection.history.push({ txid: tx.txid, deltaUnits: String(received - sent), feeUnits: String(fee), status: 'pending', confirmations: 0, blockHeight: null, timestamp });
        collection.candidates.push(...ownedCandidates);
        if (!appendSpendEdges(collection.spentOutpoints, spendSeen, tx.txid, tx.inputs)) { collection.complete = false; collection.warnings.push('Wallet spend graph limit reached; synchronization is incomplete.'); }
      } catch {
        collection.complete = false; collection.warnings.push('Relevant Core mempool transfer cannot be fully verified; pending transfers are incomplete.');
      }
    });
    const spent = new Set(collection.spentOutpoints.filter(s => mempoolIds.has(s.spentByTxid)).map(s => key(s.txid, s.vout)));
    collection.candidates = collection.candidates.filter(c => !spent.has(key(c.txid, c.vout)));
  }

  private async mainnetHistory(addresses: string[], network: NetworkInfo): Promise<Collection> {
    const used = new Set<string>(); const history = new Map<string, HistoryEntry>(); const warnings: string[] = [];
    const txHints = new Map<string, { height: number | null; blockHash?: string }>(); let complete = true;
    const remaining = { requests: Math.min(this.config.maxHistoryTransactions + 100, 1000) };
    await mapBounded(addresses, async address => {
      let reachedEnd = false; const addressSeen = new Set<string>(); let expectedTotal: number | undefined;
      for (let page = 1; page <= this.config.maxHistoryPages; page++) {
        if (--remaining.requests < 0) { complete = false; break; }
        let payload: RecordData;
        try { payload = record(await this.publicGet(`/api/address/${encodeURIComponent(address)}?page=${page}&page_size=100`)); }
        catch { complete = false; warnings.push('Address history is unavailable; discovery is incomplete.'); break; }
        const index = record(payload.status);
        if (!indexSupportsAcceptedTip(index, { height: network.height, hash: network.tipHash,
          headers: network.height + (network.pendingValidationBlocks ?? 0) }, Math.floor(Date.now() / 1000), this.config.maxTipAgeSeconds)) {
          complete = false; warnings.push('Address index changed during synchronization.');
        }
        const txs = array(payload.transactions, 200); const pagination = record(payload.pagination);
        ensure(integer(pagination.page, 1) === page && typeof pagination.has_next === 'boolean');
        const total = integer(pagination.total); integer(pagination.total_pages);
        if (expectedTotal !== undefined && expectedTotal !== total) { complete = false; warnings.push('Address history changed during pagination.'); }
        expectedTotal = total;
        if (txs.length) used.add(address);
        for (const value of txs) {
          const tx = record(value); const txid = hash(tx.txid);
          if (addressSeen.has(txid)) { complete = false; warnings.push('Address history pagination overlaps; retry required.'); continue; }
          addressSeen.add(txid);
          const height = tx.block_height == null ? null : integer(tx.block_height);
          const status = tx.status === 'pending' || height === null ? 'pending' : 'confirmed';
          if (height !== null && height > network.height) { complete = false; continue; }
          const blockHash = height === null ? undefined : hash(tx.block_hash);
          const delta = atomic(tx.delta_sats); const fee = tx.fee_sats == null ? null : atomic(tx.fee_sats); ensure(fee === null || fee >= 0n);
          const existing = history.get(txid);
          if (existing) {
            ensure(existing.status === status && existing.blockHeight === height && existing.feeUnits === (fee === null ? null : String(fee)), 'Conflicting address history entries');
            existing.deltaUnits = String(BigInt(existing.deltaUnits) + delta);
          } else {
            if (history.size >= this.config.maxHistoryTransactions) { complete = false; warnings.push('History limit reached; wallet discovery is incomplete.'); break; }
            history.set(txid, { txid, deltaUnits: String(delta), feeUnits: fee === null ? null : String(fee), status, confirmations: height === null ? 0 : network.height - height + 1, blockHeight: height, timestamp: tx.timestamp == null ? null : integer(tx.timestamp) });
            txHints.set(txid, { height, blockHash });
          }
        }
        if (!pagination.has_next) { reachedEnd = true; break; }
        if (!txs.length) { complete = false; break; }
      }
      if (!reachedEnd || addressSeen.size !== expectedTotal) complete = false;
    });
    const addressesSet = new Set(addresses); const candidates: Candidate[] = []; const ownedOutpoints = new Map<string, Candidate>(); const spentOutpoints: SpentOutpoint[] = []; const spendSeen = new Set<string>();
    await mapBounded([...txHints], async ([txid, hint]) => {
      if (hint.height === null) return; // Core supplies authoritative pending detail below.
      let tx: RecordData;
      try { tx = record(record(await this.publicGet(`/api/tx/${txid}`)).transaction); }
      catch { complete = false; warnings.push('Transaction details are unavailable.'); return; }
      ensure(tx.txid === txid && typeof tx.is_coinbase === 'boolean');
      try {
        ensure(hint.blockHash && hash(await this.rpc.call('getblockhash', [hint.height])) === hint.blockHash, 'Confirmed history block is not canonical');
        // Cached/fallback raw bytes prove identity, not inclusion. Require a
        // fresh own-Core read from that canonical block before emitting edges.
        let included: RecordData | null;
        try { included = record(await this.rpc.call('getrawtransaction', [txid, true, hint.blockHash])); }
        catch (error) {
          if (!(error instanceof RpcError) || ![-1, -5].includes(error.code)) throw error;
          const chain = record(await this.rpc.call('getblockchaininfo'));
          ensure(chain.pruned === true && integer(chain.pruneheight) > hint.height && hash(chain.bestblockhash) === network.tipHash, 'Confirmed block membership is unavailable on an unpruned block');
          // Pruned history remains an explorer hint, never a verified spend edge.
          // Current gettxout + native raw checks can still prove an old coin.
          included = null; warnings.push('Historical spend proofs are unavailable for pruned blocks; current Core outputs remain independently checked.');
        }
        if (included) {
          ensure(included.txid === txid && included.in_active_chain === true && hash(included.blockhash) === hint.blockHash && integer(included.confirmations, 1) === network.height - hint.height + 1 && typeof included.hex === 'string', 'Confirmed transaction is not in the canonical block');
          const parent = await this.nativeParent(txid, hint.blockHash);
          ensure(included.hex.toLowerCase() === parent.rawHex, 'Confirmed Core raw bytes differ from cached history');
          if (!parent.decoded.coinbase && !appendSpendEdges(spentOutpoints, spendSeen, txid, parent.decoded.inputs)) { complete = false; warnings.push('Wallet spend graph limit reached; synchronization is incomplete.'); }
        }
      } catch { complete = false; warnings.push('Confirmed transfer raw data cannot be verified; spend history is incomplete.'); }
      const outputs = array(tx.outputs, 2000); ensure(integer(tx.output_count) === outputs.length);
      for (let n = 0; n < outputs.length; n++) { const output = record(outputs[n]); ensure(integer(output.vout_index) === n);
        if (typeof output.address !== 'string' || !addressesSet.has(output.address)) continue;
        const amount = atomic(output.value_sats); ensure(amount >= 0n);
        if (candidates.length >= this.config.maxHistoryTransactions) { complete = false; warnings.push('UTXO limit reached.'); continue; }
        const candidate = { txid, vout: n, address: output.address, scriptHex: script(output.script_hex), amount, blockHeight: hint.height, blockHash: hint.blockHash, coinbase: tx.is_coinbase };
        candidates.push(candidate); ownedOutpoints.set(key(txid, n), candidate);
      }
    });
    return { candidates, history: [...history.values()], used, complete, warnings, ownedOutpoints, spentOutpoints };
  }

  private async ensureWatchWallet(addresses: string[]): Promise<void> {
    const perform = async () => {
      let info: RecordData;
      try { info = record(await this.rpc.call('getwalletinfo', [], this.config.watchWallet)); }
      catch (error) {
        if (!(error instanceof RpcError) || error.code !== -18) throw error;
        if (!this.config.allowWatchWalletCreation) throw new GatewayError('watch-wallet-unavailable', 'Isolated watch-only wallet is not configured');
        try { await this.rpc.call('loadwallet', [this.config.watchWallet]); }
        catch (loadError) {
          if (!(loadError instanceof RpcError) || ![-18, -4].includes(loadError.code)) throw loadError;
          await this.rpc.call('createwallet', [this.config.watchWallet, true, true, '', false, true, true]);
        }
        info = record(await this.rpc.call('getwalletinfo', [], this.config.watchWallet));
      }
      ensure(info.private_keys_enabled === false && info.descriptors === true, 'Gateway requires a descriptor wallet with private keys disabled');
      ensure(info.scanning === false, 'Watch-only wallet is still rescanning');
      const listed = record(await this.rpc.call('listdescriptors', [false], this.config.watchWallet));
      const descriptors = array(listed.descriptors, this.config.maxWatchedAddresses + 100).map(v => record(v).desc);
      ensure(descriptors.every(v => typeof v === 'string' && /^addr\([a-z0-9]+\)#[a-z0-9]+$/.test(v)), 'Watch-only wallet contains unexpected descriptors');
      const missing = addresses.filter(address => !descriptors.some(desc => (desc as string).startsWith(`addr(${address})#`)));
      if (descriptors.length + missing.length > this.config.maxWatchedAddresses) throw new GatewayError('watch-limit-reached', 'Watch-only address limit reached', 429);
      if (!missing.length) return;
      const imports = await mapBounded(missing, async address => {
        const result = record(await this.rpc.call('getdescriptorinfo', [`addr(${address})`]));
        ensure(typeof result.descriptor === 'string' && result.descriptor.startsWith(`addr(${address})#`) && result.hasprivatekeys === false, 'Invalid public descriptor');
        return { desc: result.descriptor, timestamp: 0, active: false, internal: false };
      });
      const imported = array(await this.rpc.call('importdescriptors', [imports], this.config.watchWallet), addresses.length);
      ensure(imported.length === imports.length && imported.every(v => record(v).success === true), 'Watch-only address import or rescan failed');
      const after = record(await this.rpc.call('getwalletinfo', [], this.config.watchWallet)); ensure(after.scanning === false, 'Watch-only wallet is still rescanning');
    };
    const result = this.watchQueue.then(perform, perform); this.watchQueue = result.catch(() => undefined); await result;
  }

  private async regtestHistory(addresses: string[], scripts: Map<string, string>, network: NetworkInfo): Promise<Collection> {
    await this.ensureWatchWallet(addresses);
    const collected = new Map<string, RecordData>(); const warnings: string[] = []; let complete = true; let ended = false;
    for (let page = 0; page < this.config.maxHistoryPages; page++) {
      const rows = array(await this.rpc.call('listtransactions', ['*', 100, page * 100, true], this.config.watchWallet), 100);
      for (const value of rows) { const row = record(value); const txid = hash(row.txid);
        if (!collected.has(txid) && collected.size >= this.config.maxHistoryTransactions) { complete = false; break; }
        collected.set(txid, row);
      }
      if (rows.length < 100) { ended = true; break; }
    }
    if (!ended) { complete = false; warnings.push('Watch-only history limit reached.'); }
    const transactions = new Map<string, { tx: NativeTransaction; metadata: RecordData }>();
    const ownOutputs = new Map<string, { amount: bigint; address: string }>(); const candidates: Candidate[] = []; const used = new Set<string>();
    for (const [txid] of collected) {
      let metadata: RecordData; let tx: NativeTransaction;
      try { metadata = record(await this.rpc.call('gettransaction', [txid, true], this.config.watchWallet));
        ensure(typeof metadata.hex === 'string'); tx = decodeNativeTransaction(metadata.hex); ensure(tx.txid === txid); this.rememberRaw(txid, metadata.hex); }
      catch { complete = false; warnings.push('A watch-only transaction could not be decoded.'); continue; }
      transactions.set(txid, { tx, metadata });
      const confirmations = typeof metadata.confirmations === 'number' ? integer(Math.max(0, metadata.confirmations)) : 0;
      const height = metadata.blockheight == null ? (confirmations > 0 ? network.height - confirmations + 1 : null) : integer(metadata.blockheight);
      for (const output of tx.outputs) { const address = scripts.get(output.scriptHex); if (!address) continue;
        used.add(address); ownOutputs.set(key(txid, output.vout), { amount: BigInt(output.amountUnits), address });
        if (typeof metadata.confirmations === 'number' && metadata.confirmations < 0) continue;
        candidates.push({ txid, vout: output.vout, address, scriptHex: output.scriptHex, amount: BigInt(output.amountUnits), blockHeight: height, blockHash: metadata.blockhash == null ? undefined : hash(metadata.blockhash), coinbase: tx.coinbase });
      }
    }
    const spent = new Set<string>(); const history: HistoryEntry[] = [];
    for (const [txid, { tx, metadata }] of transactions) {
      const conflicted = typeof metadata.confirmations === 'number' && metadata.confirmations < 0;
      let received = 0n; let sent = 0n; let relevant = false;
      for (const output of tx.outputs) if (scripts.has(output.scriptHex)) { relevant = true; received += BigInt(output.amountUnits); }
      for (const input of tx.inputs) {
        const outpoint = key(input.txid, input.vout); const owned = ownOutputs.get(outpoint);
        if (owned) { relevant = true; used.add(owned.address); sent += owned.amount; }
        if (!conflicted) spent.add(outpoint);
      }
      if (!relevant) continue;
      const confirmations = integer(Math.max(0, typeof metadata.confirmations === 'number' ? metadata.confirmations : 0));
      history.push({ txid, deltaUnits: String(received - sent), feeUnits: metadata.fee == null ? null : String(-coinUnits(metadata.fee)), status: conflicted ? 'conflicted' : confirmations > 0 ? 'confirmed' : 'pending', confirmations, blockHeight: confirmations > 0 ? (metadata.blockheight == null ? network.height - confirmations + 1 : integer(metadata.blockheight)) : null, timestamp: metadata.blocktime == null ? (metadata.time == null ? null : integer(metadata.time)) : integer(metadata.blocktime) });
    }
    const activeHistory = new Set(history.filter(h => h.status !== 'conflicted').map(h => h.txid));
    const spentOutpoints: SpentOutpoint[] = []; const spendSeen = new Set<string>();
    for (const [txid, { tx }] of transactions) if (activeHistory.has(txid) && !tx.coinbase && !appendSpendEdges(spentOutpoints, spendSeen, txid, tx.inputs)) { complete = false; warnings.push('Wallet spend graph limit reached; synchronization is incomplete.'); }
    return { candidates: candidates.filter(c => !spent.has(key(c.txid, c.vout))), history, used, complete, warnings, ownedOutpoints: new Map(candidates.map(c => [key(c.txid, c.vout), c])), spentOutpoints };
  }

  async sync(addresses: string[]): Promise<WalletSnapshot> {
    const network = await this.network();
    if (!network.ready) return { network, addresses: addresses.map(address => ({ address, used: false })), utxos: [], history: [], complete: false, warnings: ['Chain data is not synchronized or fresh.'], observedAt: iso() };
    const pool = await this.mempoolSnapshot(); const fingerprint = pool.fingerprint; const scripts = await this.validateAddresses(addresses);
    const collection = this.config.network === 'mainnet' ? await this.mainnetHistory(addresses, network) : await this.regtestHistory(addresses, scripts, network);
    if (this.config.network === 'mainnet') await this.overlayMempool(pool.ids, scripts, collection);
    const parents = new Map<string, Promise<NativeParent>>(); const utxos: Utxo[] = []; const seen = new Set<string>();
    const spent = new Set(collection.spentOutpoints.map(s => key(s.txid, s.vout)));
    const candidates = collection.candidates.slice(0, this.config.maxHistoryTransactions);
    if (candidates.length < collection.candidates.length) { collection.complete = false; collection.warnings.push('UTXO limit reached.'); }
    for (const candidate of candidates) {
      const outpoint = key(candidate.txid, candidate.vout); if (seen.has(outpoint)) continue; seen.add(outpoint);
      const current = await this.rpc.call('gettxout', [candidate.txid, candidate.vout, true]); if (current === null) continue;
      if (spent.has(outpoint)) { collection.complete = false; collection.warnings.push('Verified spend graph conflicts with a current Core output; synchronization is incomplete.'); }
      const output = record(current); const amount = coinUnits(output.value); const scriptHex = script(record(output.scriptPubKey).hex);
      ensure(amount === candidate.amount && scriptHex === candidate.scriptHex && scripts.get(scriptHex) === candidate.address, 'UTXO amount or script differs from indexed history');
      ensure(typeof output.coinbase === 'boolean'); const confirmations = integer(output.confirmations);
      if (output.bestblock !== undefined && hash(output.bestblock) !== network.tipHash) { collection.complete = false; collection.warnings.push('Core tip changed while checking UTXOs.'); }
      let classification: Utxo['classification'] = 'unknown'; let rawParent: string | null = null; let verified = false;
      try {
        if (Object.keys(output).some(k => ['asset_id', 'asset_units', 'icu', 'icu_units'].includes(k))) throw new GatewayError('unsupported-transaction', 'Asset outputs are unsupported', 422);
        if (!parents.has(candidate.txid)) parents.set(candidate.txid, this.nativeParent(candidate.txid, candidate.blockHash));
        const parent = await parents.get(candidate.txid)!; const prev = parent.decoded.outputs[candidate.vout];
        ensure(prev && prev.scriptHex === scriptHex && BigInt(prev.amountUnits) === amount && parent.decoded.coinbase === output.coinbase, 'UTXO and raw parent disagree');
        classification = 'native'; rawParent = parent.rawHex; verified = true;
      } catch (error) {
        if (error instanceof GatewayError && error.code === 'unsupported-transaction') classification = 'unsupported';
        else collection.warnings.push('Some outputs cannot be verified and are excluded from spending.');
      }
      utxos.push({ txid: candidate.txid, vout: candidate.vout, address: candidate.address, scriptHex, amountUnits: String(amount), confirmations, blockHeight: confirmations > 0 ? network.height - confirmations + 1 : null, coinbase: output.coinbase, classification, rawParent, verified });
    }
    const endFingerprint = await this.mempoolFingerprint(); const endNetwork = await this.network();
    if (fingerprint !== endFingerprint || network.tipHash !== endNetwork.tipHash || !endNetwork.ready) { collection.complete = false; collection.warnings.push('Chain or mempool changed during synchronization; retry required.'); }
    collection.history.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0) || a.txid.localeCompare(b.txid));
    const spentOutpoints = [...new Map(collection.spentOutpoints.map(s => [`${key(s.txid, s.vout)}:${s.spentByTxid}`, s])).values()].slice(0, MAX_SPEND_EDGES);
    if (collection.spentOutpoints.length > MAX_SPEND_EDGES) { collection.complete = false; collection.warnings.push('Wallet spend graph limit reached; synchronization is incomplete.'); }
    const snapshot = { network, addresses: addresses.map(address => ({ address, used: collection.used.has(address) })), utxos, history: collection.history, complete: collection.complete, warnings: [...new Set(collection.warnings)], observedAt: iso(), mempoolFingerprint: fingerprint, spentOutpoints };
    if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > 16_000_000) throw new GatewayError('snapshot-too-large', 'Wallet snapshot exceeds the safe response limit');
    return snapshot;
  }

  async fees(): Promise<FeePolicy> {
    await this.requireReady(); const mempool = record(await this.rpc.call('getmempoolinfo'));
    const relay = feeRate(mempool.minrelaytxfee); const floor = feeRate(mempool.mempoolminfee); let suggested = relay > floor ? relay : floor;
    try { const estimate = record(await this.rpc.call('estimatesmartfee', [6, 'CONSERVATIVE'])); if (estimate.feerate !== undefined) { const rate = feeRate(estimate.feerate); if (rate > suggested) suggested = rate; } }
    catch (error) { if (!(error instanceof RpcError)) throw error; }
    if (suggested < 1n) suggested = 1n;
    if (suggested > BigInt(this.config.maximumFeeRate)) throw new GatewayError('fee-policy-too-high', 'Current network fee floor exceeds wallet fee cap');
    return { relayFloorUnitsPerVbyte: String(relay), mempoolFloorUnitsPerVbyte: String(floor), suggestedRate: String(suggested), observedAt: iso() };
  }

  private async alreadyKnown(txid: string, submitted?: NativeTransaction): Promise<boolean> {
    try { record(await this.rpc.call('getmempoolentry', [txid])); return true; }
    catch (error) { if (!(error instanceof RpcError) || ![-5, -8].includes(error.code)) throw error; }
    try { const tx = record(await this.rpc.call('getrawtransaction', [txid, true])); return tx.txid === txid && typeof tx.confirmations === 'number' && tx.confirmations > 0; }
    catch (error) { if (!(error instanceof RpcError) || ![-1, -5].includes(error.code)) throw error; }
    if (this.config.network === 'regtest') {
      try { const tx = record(await this.rpc.call('gettransaction', [txid, true], this.config.watchWallet)); return typeof tx.confirmations === 'number' && tx.confirmations >= 0 && (tx.confirmations > 0 || tx.trusted === true || tx.in_mempool === true); }
      catch (error) { if (!(error instanceof RpcError) || ![-5, -18].includes(error.code)) throw error; }
    }
    if (this.config.network === 'mainnet') {
      try {
        const hint = record(record(await this.publicGet(`/api/tx/${txid}`)).transaction);
        if (hint.txid === txid && hint.block_height != null && hint.block_hash != null) {
          const blockHash = hash(hint.block_hash); const height = integer(hint.block_height);
          if (hash(await this.rpc.call('getblockhash', [height])) === blockHash) {
            const known = record(await this.rpc.call('getrawtransaction', [txid, true, blockHash]));
            if (known.txid === txid && known.in_active_chain === true && integer(known.confirmations, 1) > 0) return true;
          }
        }
      } catch (error) {
        if (error instanceof RpcError && ![-1, -5, -8].includes(error.code)) throw error;
        if (error instanceof GatewayError && !['not-found', 'index-unavailable', 'invalid-provider-data'].includes(error.code)) throw error;
      }
      if (submitted) for (const output of submitted.outputs) {
        const current = await this.rpc.call('gettxout', [txid, output.vout, true]); if (current === null) continue;
        const item = record(current);
        // A current outpoint keyed by this exact locally computed txid proves Core
        // already has the transaction even when its original block is pruned.
        if (item.coinbase === false && coinUnits(item.value) === BigInt(output.amountUnits) && script(record(item.scriptPubKey).hex) === output.scriptHex) return true;
      }
    }
    return false;
  }

  private parseSigned(rawHex: string): NativeTransaction {
    let tx: NativeTransaction;
    try { tx = decodeNativeTransaction(rawHex); } catch { throw new GatewayError('unsupported-transaction', 'Invalid or unsupported native transaction', 422); }
    if (tx.coinbase || tx.inputs.length > 200 || tx.outputs.length > 200 || tx.vsize > 100000 || tx.outputs.some(v => !P2WPKH.test(v.scriptHex)) || tx.inputs.some(v => v.scriptHex !== '')) throw new GatewayError('unsupported-transaction', 'Only ordinary P2WPKH transfers are supported', 422);
    if (new Set(tx.inputs.map(i => key(i.txid, i.vout))).size !== tx.inputs.length) throw new GatewayError('invalid-transaction', 'Duplicate transaction inputs', 422);
    return tx;
  }

  private async absentFromMempool(txid: string): Promise<boolean> {
    try { record(await this.rpc.call('getmempoolentry', [txid])); return false; }
    catch (error) { return error instanceof RpcError && error.code === -5; }
  }

  private async rejected(tx: NativeTransaction, reason: string): Promise<ValidationResult> {
    const result: ValidationResult = { txid: tx.txid, allowed: false, reason, canDiscard: false };
    try {
      const before = await this.requireReady(); const beforePool = await this.mempoolFingerprint();
      if (!await this.absentFromMempool(tx.txid)) return result;
      for (const input of tx.inputs) {
        const value = await this.rpc.call('gettxout', [input.txid, input.vout, true]); if (value === null) return result;
        const current = record(value); const amount = coinUnits(current.value); const scriptHex = script(record(current.scriptPubKey).hex);
        if (!P2WPKH.test(scriptHex) || typeof current.coinbase !== 'boolean' || (current.bestblock !== undefined && hash(current.bestblock) !== before.tipHash)) return result;
        const parent = await this.nativeParent(input.txid); const output = parent.decoded.outputs[input.vout];
        if (!output || output.scriptHex !== scriptHex || BigInt(output.amountUnits) !== amount || parent.decoded.coinbase !== current.coinbase) return result;
      }
      const afterPool = await this.mempoolFingerprint(); const after = await this.network();
      if (!after.ready || before.tipHash !== after.tipHash || beforePool !== afterPool || !await this.absentFromMempool(tx.txid)) return result;
      // An accepted transaction must consume at least one signed input. All of
      // them are still unspent in both chain and mempool, under a stable snapshot.
      // This is a current-state proof for explicit user discard, never an
      // automatic deletion or a promise about a later externally submitted tx.
      return { ...result, canDiscard: true };
    } catch { return result; }
  }

  async validate(rawHex: string): Promise<ValidationResult> {
    return this.validateAtTip(rawHex, await this.requireReady());
  }

  private async requireSameAcceptedTip(network: NetworkInfo): Promise<void> {
    const current = await this.requireReady();
    if (current.height !== network.height || current.tipHash !== network.tipHash)
      throw new GatewayError('stale-outpoint', 'The accepted chain changed. Refresh and retry the same signed transfer.');
  }

  private async validateAtTip(rawHex: string, network: NetworkInfo): Promise<ValidationResult> {
    const tx = this.parseSigned(rawHex);
    // Strict local decoding forbids extension flags; Core independently classifies it.
    this.rememberRaw(tx.txid, rawHex); await this.nativeParent(tx.txid);
    if (await this.alreadyKnown(tx.txid, tx)) return { txid: tx.txid, allowed: true, alreadyKnown: true };
    let inputTotal = 0n;
    for (const input of tx.inputs) {
      const value = await this.rpc.call('gettxout', [input.txid, input.vout, true]);
      if (value === null) {
        if (this.config.network === 'mainnet') throw new GatewayError('transaction-state-unknown', 'Inputs are unavailable; previous acceptance cannot be determined. Reconcile or retry the identical transaction.', 503);
        return { txid: tx.txid, allowed: false, reason: 'An input is already spent or unavailable.', canDiscard: false };
      }
      const current = record(value); const amount = coinUnits(current.value); const scriptHex = script(record(current.scriptPubKey).hex);
      if (!P2WPKH.test(scriptHex) || typeof current.coinbase !== 'boolean' || integer(current.confirmations) < this.config.minConfirmations || (current.coinbase && integer(current.confirmations) < this.config.coinbaseMaturity)) return this.rejected(tx, 'An input is unsupported, unconfirmed, or immature.');
      if (current.bestblock !== undefined && hash(current.bestblock) !== network.tipHash) throw new GatewayError('stale-outpoint', 'Chain changed while validating transaction');
      const parent = await this.nativeParent(input.txid); const output = parent.decoded.outputs[input.vout];
      ensure(output && output.scriptHex === scriptHex && BigInt(output.amountUnits) === amount, 'Input and raw parent disagree'); inputTotal += amount;
    }
    const outputTotal = tx.outputs.reduce((sum, o) => sum + BigInt(o.amountUnits), 0n); const fee = inputTotal - outputTotal;
    if (fee <= 0n || fee > BigInt(this.config.maximumFeeUnits) || fee > BigInt(this.config.maximumFeeRate) * BigInt(tx.vsize)) return this.rejected(tx, 'Transaction fee exceeds wallet cap or is invalid.');
    const policy = await this.fees(); const floor = BigInt(policy.relayFloorUnitsPerVbyte) > BigInt(policy.mempoolFloorUnitsPerVbyte) ? BigInt(policy.relayFloorUnitsPerVbyte) : BigInt(policy.mempoolFloorUnitsPerVbyte);
    if (fee < floor * BigInt(tx.vsize)) return this.rejected(tx, 'Transaction fee is below current relay policy.');
    const results = array(await this.rpc.call('testmempoolaccept', [[rawHex], this.maxRateCoinPerKvbyte()]), 1); ensure(results.length === 1);
    const result = record(results[0]); ensure(result.txid === tx.txid && typeof result.allowed === 'boolean', 'Core validation transaction identity mismatch');
    if (!result.allowed) return this.rejected(tx, typeof result['reject-reason'] === 'string' ? result['reject-reason'].slice(0, 160).replace(/[\r\n\x00-\x1f]/g, '') : 'Core rejected the transaction.');
    await this.requireSameAcceptedTip(network);
    return { txid: tx.txid, allowed: true };
  }

  private maxRateCoinPerKvbyte(): string { const units = BigInt(this.config.maximumFeeRate) * 1000n; return `${units / 100000000n}.${(units % 100000000n).toString().padStart(8, '0')}`; }

  async broadcast(rawHex: string): Promise<BroadcastResult> {
    const network = await this.requireReady();
    const validation = await this.validateAtTip(rawHex, network);
    if (!validation.allowed) throw new GatewayError('transaction-rejected', validation.reason || 'Transaction rejected', 422);
    if (validation.alreadyKnown) return { txid: validation.txid, status: 'already-known' };
    await this.requireSameAcceptedTip(network);
    try { const txid = hash(await this.rpc.call('sendrawtransaction', [rawHex, this.maxRateCoinPerKvbyte()]));
      ensure(txid === validation.txid, 'Broadcast transaction identity mismatch'); return { txid, status: 'accepted' };
    } catch (error) {
      if (error instanceof RpcError && error.code === -27 && await this.alreadyKnown(validation.txid)) return { txid: validation.txid, status: 'already-known' };
      if (error instanceof RpcError && [-25, -26].includes(error.code)) throw new GatewayError('transaction-rejected', 'Core rejected the transaction', 422);
      throw new GatewayError('broadcast-outcome-unknown', 'Broadcast outcome is unknown; check or retry the identical transaction', 503);
    }
  }
}
