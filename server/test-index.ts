// Test double for the address-history index (tscscan v1 API) and the raw-hex seed.
export const INDEX_TIP = { height: 200, hash: 'a'.repeat(64) };
export const isoAgo = (seconds = 0) => new Date(Date.now() - seconds * 1000).toISOString();
export const units = (value: number | null) => value === null ? { precision: 8, state: 'unknown', units: null } : { precision: 8, units: String(value) };

export function indexStatus(overrides: Record<string, unknown> = {}, height = INDEX_TIP.height) {
  const covered = { scope: 'chain_wide', state: 'complete', through_height: height };
  return { network: 'mainnet', sync_state: 'ready', core_initial_block_download: false, last_core_poll_at: isoAgo(1),
    observed_core_height: height, observed_header_height: height,
    coverage: { blocks: covered, transactions: covered, addresses: covered, assets: covered }, ...overrides };
}

export interface IndexRow { txid: string; height: number | null; blockHash?: string; delta: number; fee?: number | null; time?: number | null; coinbase?: boolean; }
export function historyRow(row: IndexRow) {
  return { txid: row.txid, block_height: row.height, block_hash: row.height === null ? null : row.blockHash ?? INDEX_TIP.hash,
    delta: units(row.delta), fee: units(row.fee ?? null), time: row.time ?? null, is_coinbase: row.coinbase ?? false,
    received: units(Math.max(row.delta, 0)), sent: units(Math.max(-row.delta, 0)), from_address_count: 0, from_addresses: [], to_address_count: 0, to_addresses: [] };
}
export const historyPage = (rows: IndexRow[], number = 1, total = rows.length, totalPages = Math.max(1, Math.ceil(total / 100))) =>
  ({ data: rows.map(historyRow), page: { limit: 100, number, total, total_pages: totalPages } });

export interface IndexOptions {
  tip?: { height: number; hash: string };                               // chain headers of every index response
  status?: Record<string, unknown> | (() => Record<string, unknown>);   // /v1/status data overrides
  statusTip?: () => { height: number; hash: string };                   // chain headers of /v1/status only
  dataTip?: { height: number; hash: string };                            // chain headers of every other response
  history?: Record<string, IndexRow[]>;                                  // address → confirmed rows, paged by limit/page
  pages?: Record<string, unknown>;                                       // address → raw page body
  failHistory?: number;                                                  // HTTP status for every history page
  transactions?: Record<string, { height: number; hash: string }>;      // /v1/transactions/{txid} block hint
  outputs?: Record<string, { address: string | null; value: number }[]>;
  seed?: Record<string, string>;                                         // txid → raw hex served by the seed
  anchor?: (height: number, hash: string) => boolean;                    // accepted anchors (default: the current tip)
  log?: string[];
}

export function indexFetch(options: IndexOptions = {}): typeof fetch {
  return (async (input, init) => {
    const url = new URL(String(input)); options.log?.push(`${url.host}${url.pathname}${url.search}`);
    const tip = options.tip ?? INDEX_TIP;
    const reply = (body: unknown, status = 200, chain = tip) => new Response(JSON.stringify(body), { status,
      headers: { 'content-type': 'application/json', 'x-chain-height': String(chain.height), 'x-chain-hash': chain.hash } });
    const seed = url.pathname.match(/^\/api\/tx\/([0-9a-f]{64})\/hex$/);
    if (seed) return options.seed?.[seed[1]] ? new Response(options.seed[seed[1]]) : new Response('not found', { status: 404 });
    if (url.host !== 'api.tscscan.xyz' || !url.pathname.startsWith('/v1/')) return new Response('{}', { status: 404 });
    const requested = new Headers(init?.headers); const anchorHeight = requested.get('x-chain-height');
    if (anchorHeight !== null) {
      const hash = requested.get('x-chain-hash') ?? '';
      const accepted = options.anchor ? options.anchor(Number(anchorHeight), hash) : Number(anchorHeight) === tip.height && hash === tip.hash;
      if (!accepted) return reply({ code: 'CHAIN_ANCHOR_INVALIDATED', status: 409 }, 409);
    }
    const path = url.pathname.slice(3); const page = Number(url.searchParams.get('page') || 1);
    const json = (body: unknown, status = 200) => reply(body, status, options.dataTip);
    if (path === '/status') return reply({ data: indexStatus(typeof options.status === 'function' ? options.status() : options.status, tip.height) }, 200, options.statusTip?.() ?? tip);
    const history = path.match(/^\/addresses\/([^/]+)\/transactions$/);
    if (history) {
      if (options.failHistory) return json({ code: 'UNAVAILABLE' }, options.failHistory);
      const address = decodeURIComponent(history[1]);
      if (options.pages?.[address] !== undefined) return json(options.pages[address]);
      const rows = options.history?.[address] ?? [];
      return json(historyPage(rows.slice((page - 1) * 100, page * 100), page, rows.length));
    }
    const outputs = path.match(/^\/transactions\/([0-9a-f]{64})\/outputs$/);
    if (outputs) {
      const list = options.outputs?.[outputs[1]]; if (!list) return json({ code: 'RESOURCE_NOT_FOUND' }, 404);
      return json({ data: list.slice((page - 1) * 100, page * 100).map((o, n) => ({ index: (page - 1) * 100 + n, address: o.address, value: units(o.value), spend_state: 'unspent', spent_by_txid: null })),
        page: { limit: 100, number: page, total: list.length, total_pages: Math.max(1, Math.ceil(list.length / 100)) } });
    }
    const transaction = path.match(/^\/transactions\/([0-9a-f]{64})$/);
    if (transaction) {
      const block = options.transactions?.[transaction[1]]; if (!block) return json({ code: 'RESOURCE_NOT_FOUND' }, 404);
      return json({ data: { txid: transaction[1], block, state: 'confirmed' } });
    }
    return json({ code: 'RESOURCE_NOT_FOUND' }, 404);
  }) as typeof fetch;
}
