# Chain-data gateway

`buildApp(config: GatewayConfig)` exports a Fastify application without binding a
socket. `index.ts` reads environment variables and binds loopback only. The
gateway never receives user seed/private keys, creates user signing wallets, or
provides an arbitrary RPC relay. Request and RPC-body logging are disabled.

| Route | Request / response |
|---|---|
| `GET /api/build` | Immutable manifest metadata; no Core/RPC dependency; `Cache-Control: no-store` |
| `GET /api/v1/network` | `NetworkInfo`; exact chain/full genesis, accepted Core tip, tip age and matching explorer view |
| `POST /api/v1/wallet/sync` | Strict `{addresses: string[]}` (1–100 unique P2WPKH addresses); `WalletSnapshot` |
| `GET /api/v1/tx/:txid/raw` | `{txid, rawHex}`; optional validated `?blockHash=` hint |
| `GET /api/v1/fees` | `FeePolicy`, rounded up from dynamic Core floors/estimate |
| `POST /api/v1/tx/validate` | Strict `{rawHex}`; `ValidationResult` |
| `POST /api/v1/tx/broadcast` | Strict `{rawHex}`; `BroadcastResult` or explicit unknown outcome |
| `GET /health` | HTTP 200 only when chain/index ready; otherwise HTTP 503 |

Defaults are mainnet (`tensor`), RPC `127.0.0.1:39242`, server `127.0.0.1:8790`,
two confirmations, coinbase maturity 100, absolute fee cap 1,000,000 atomic units
and rate cap 100 units/vbyte. Configure an explicit private cookie path or
server-only RPC credentials. Mainnet uses TSCScan for paginated confirmed history and own Core
for authoritative pending history, incoming outputs, outgoing spends and change.
Core checks current outpoints and independently classifies native raw parents.
Seed raw fallback is identity-checked locally. A missing/pruned raw parent is
unverified and cannot be spent. Unknown extension flags/assets/ICU are excluded.

Readiness depends on freshly checked observations and exact accepted-chain/index
alignment, not on how recently a block was mined. An unchanged chain can still
supply balances and accept transactions into Core's mempool. A fresh explorer
status (`checked_at` within 30 seconds), zero lag, matching accepted height/hash,
completed initial synchronization and full effective-work verification may
override only the known block-age and pending-header advisories. Unknown or
additional warnings, stale status, mismatched tips and incomplete history still
fail closed. Block age remains visible in `lastBlockTime`; it neither creates
confirmations nor makes cached balances spendable. Future block timestamps beyond
the two-hour sanity tolerance remain rejected. `WALLET_MAX_TIP_AGE` is retired;
setting that former environment variable no longer imposes a mining-age limit.

Two before/after Core mempool fingerprints and chain/index tip checks detect
snapshot races. `complete: false` must block discovery/send and trigger a bounded
client retry. An unchanged fingerprint does not independently prove explorer
history retention. All candidate outputs are nevertheless checked through
`gettxout(..., true)`; a missing explorer pending spend cannot make a spent output
available. The global fingerprint can require retries during unrelated activity.
History pages/transactions and watched addresses have explicit caps; hitting
history limits never claims completeness. Core mempool membership is reread on
every sync. Its immutable verbose/raw transactions are shared across concurrent
requests with a least-recently-used cache capped at the mempool transaction
limit (default 5000, hard bound 100000) and the mempool hex limit (default 16
million characters, hard bound 64 million); ordinary raw cache is separately
capped at 256 entries/16 million hex characters. Each mempool scan has the same
transaction and hex caps, a graph edge limit (default 20 per allowed mempool
transaction, hard bound 2 million) and bounded concurrency of four. The mempool
caps are independent of `WALLET_MAX_HISTORY_TRANSACTIONS`; a larger Core mempool
makes every sync incomplete. Relevant pending prevout resolution is capped by
the history transaction limit. Missing data or a cap returns `complete: false`,
never a complete zero pending balance. Unsupported unrelated Tensor traffic is
filtered by Core-decoded scripts/outpoints before the strict native checks.
`spentOutpoints` contains verified input edges only from transactions emitted
in active wallet history; it allows clients to reconcile previously accepted
change without restoring outputs spent by later transactions. No balances or
address query results are cached. Confirmed edges require fresh own-Core proof
of inclusion in the canonical block; archival/cached raw bytes alone are not
that proof. A block explicitly below Core's current prune height produces a
warning and no historical spend edge, while its still-unspent coins may remain
verified through current Core outpoints and native archival raw. An unavailable
unpruned block or a membership contradiction makes synchronization incomplete.
The accumulated wallet graph is deduplicated and capped at 100000 edges; its
cap marks the snapshot incomplete. A serialized snapshot over 16 million bytes
returns an explicit error instead of an oversized or silently truncated view.

Network responses optionally include `readinessReason`: `block-validation`,
`node-sync`, `index-sync`, `index-unavailable` or `stale-data`. These explain a
failed readiness check. Genesis, chain, initial-download, future-timestamp sanity,
index-height/hash and observation freshness requirements remain mandatory. Older responses without
the reason remain supported. The browser probes readiness every five seconds
while a known readiness gate is pending, using the network endpoint rather than
repeated address scans. Transport failures back off to 30 seconds; successful
recovery triggers a fresh wallet synchronization. Failed full wallet reads retry
after 5–30 seconds; a successful readiness probe does not consume pending wallet
recovery work. Fees are read while the address view is verified.

New headers awaiting external block validation do not invalidate Core's accepted
chain. `pendingValidationBlocks` reports this backlog without increasing the
accepted height or any confirmation count. An explorer `ready: false` response
is usable only with the known block-age advisory, the legitimate pending-header
advisory, or both: its index exactly matches Core's accepted height/hash, lag is
zero, Core is online and outside initial download, work readiness is true,
header counts agree, verification progress is one, and its status observation is
fresh. A synchronization advisory without pending headers is not accepted.
Every address-history page must satisfy the same conditions. Index lag, forks,
ambiguous states, other warnings and stale observations still block sending.
There is no independent count/duration limit on the pending-header backlog;
this is an accepted-tip view, not proof that external block validation is making
progress or that pending blocks will preserve its UTXOs.
Current outpoints, native raw parents, confirmations and Core's mempool policy
are checked before publication; the accepted tip must remain unchanged.

Mainnet network responses optionally include `averageBlockSeconds` and
`blockTimeSampleSize`: the arithmetic mean of the most recent 20 block intervals
from own-Core header timestamps. `lastBlockTime` is the current header timestamp.
Samples require a positive mean no greater than 86400 seconds and a stable
canonical tip; unavailable or invalid timing is omitted without changing the
readiness checks. Estimates are cached by immutable tip hash (eight entries)
with concurrent reads shared. Regtest exposes no automatic block-time estimate.
This is a recent observed average, not a deadline or confirmation guarantee.

Regtest uses only the isolated ordinary TensorCash regtest (`bcrt`, genesis
`cf63c021e5a8ea0bc04cf7b12ab12e0a7902ef2dae5bdd8cbb3a0d41c3345da4`) and RPC
port `19453`. An explicitly enabled fixture may create `wallet-web-watch` with
private keys disabled; existing private-key/other descriptor wallets are refused.
Public address descriptors are imported with history rescan. Mainnet never calls
wallet creation/import APIs. This watch-only fixture is not a general production
multi-user history indexer.

Publication validates native bytes, parents, current outpoints, maturity, dynamic
fees and application caps before `testmempoolaccept`/`sendrawtransaction`. Retrying
known mempool/confirmed transactions returns `already-known` without another
send. With txindex disabled, a verified canonical explorer block hint or current
submitted outpoint proves previous acceptance. If the old block is pruned and
all outputs spent, unavailable inputs return `transaction-state-unknown`; the
client must preserve and reconcile the same signed bytes. A transport timeout
returns `broadcast-outcome-unknown`, never an automatic second transaction.

`ValidationResult.canDiscard` is true only for an explicit rejection when a
separate fresh proof finds every signed input still unspent (including mempool),
matches each to a strictly native raw parent and current Core amount/script,
finds the submitted tx absent from mempool, and observes unchanged ready network
and mempool before/after. Missing/spent/unverified inputs or races never offer
discard. The browser may expose an explicit user action after this proof; it
must not silently clear a journal entry on any rejection.

Origin allowlist + strict JSON protect mutation routes. No wildcard CORS or
credentials are exposed to the browser. Fastify trusts forwarded client IPs only
from loopback; an edge proxy must overwrite `X-Forwarded-For` with the real client.
Global rate limit is 90/minute, wallet sync 60/minute, validation 20/minute,
broadcast 10/minute. The application sets a self-only CSP without inline script,
frame denial and no-store API headers. A separately managed HTTPS proxy should
publish the static frontend and `/api` under the same origin.

Environment: `WALLET_NETWORK`, `WALLET_HOST`, `WALLET_PORT`,
`WALLET_ALLOWED_ORIGINS` (comma-separated exact origins), `WALLET_STATIC_DIR`,
`CORE_RPC_URL`, `CORE_COOKIE_FILE` (or server-only `CORE_RPC_USER` and
`CORE_RPC_PASSWORD`), `WALLET_EXPLORER_URL`, `WALLET_SEED_URL`,
`WALLET_GENESIS_HASH`, `WALLET_MIN_CONFIRMATIONS`,
`WALLET_MAX_FEE_UNITS`, `WALLET_MAX_FEE_RATE`, `WALLET_RPC_TIMEOUT_MS`,
`WALLET_MAX_HISTORY_PAGES`, `WALLET_MAX_HISTORY_TRANSACTIONS`,
`WALLET_MAX_MEMPOOL_TRANSACTIONS`, `WALLET_MAX_MEMPOOL_HEX_CHARACTERS`,
`WALLET_MAX_MEMPOOL_EDGES`, `WALLET_MAX_WATCHED_ADDRESSES`, `WALLET_WATCH_WALLET`,
`WALLET_ALLOW_WATCH_CREATION=true` (isolated regtest only).
Node's `--env-file` may load a protected server env file; no dotenv dependency.
Normal cookie files must be private (0400 or 0600). `LoadCredential` may produce
a root-owned 0440 file with a read-only service ACL: that mode is accepted only
for the exact `${CREDENTIALS_DIRECTORY}/core.cookie` under `/run/credentials/`,
with a root-owned directory having no access for others or group writes and no
symlink substitutions. It does not permit group-readable source cookies or
arbitrary credential paths. Use the systemd copy for an unprivileged gateway
without changing the original Core cookie permissions.
Remote provider URLs require HTTPS. No env or
credential values belong in the static build.

Unit tests use mocks and publish no mainnet transactions. `GatewayConfig.rpc`
and `.fetch` permit controlled injection; `.syncRateLimit`/`.rateLimit` can raise
limits for a dedicated E2E fixture without changing production defaults.

Build metadata comes from the startup-validated `dist/build.json` manifest, never runtime Git or a commit environment variable. The physical static directory is pinned by realpath. Production requires a valid release manifest matching the full published source tree and artifact inventory. See [release provenance](../docs/PROVENANCE.md) and [hosting](../docs/OPERATIONS.md).
