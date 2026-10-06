# Provider model

The browser uses the same-origin gateway described in [server/README.md](../server/README.md).
The gateway combines a configured TensorCash address-history index with its own
Core node. Mainnet defaults use `https://tscscan.xyz` for history and
`https://mempool.tensorcash.org` as an optional raw-transaction fallback.
Public API availability and retention must be checked by each operator.

Address history is a source of candidate outputs, not proof that an output is
spendable. Pending spends may precede index updates. The gateway reads its
current Core mempool, verifies native parent transaction bytes and identities,
and checks each outpoint against Core with mempool inclusion. It compares chain
and index tips and mempool observations before returning a complete snapshot.
Missing data, unsupported extensions, stale observations, races and bounded
history limits fail closed for new spending. Observation freshness is separate
from block age: a pause in mining does not invalidate an unchanged accepted tip,
its existing confirmations or a freshly checked mempool. The explorer's known
block-age advisory alone does not block balances or publication when its status
was checked within 30 seconds and its complete index matches Core's accepted
height/hash. Explicit pending-header advisories can coexist with that warning;
unknown warnings, unavailable providers and inconsistent history still block.
The wallet adds no maximum-age cutoff for the last block, but both providers
must still report completed initial synchronization and the required work
readiness. A Core/provider restart during a long gap can re-enter initial block
download; this fix does not bypass that state or change Core's own heuristics.
A transaction can enter the mempool before the next block, but acceptance does
not guarantee propagation, inclusion in the next block or any particular
confirmation time.

The signer separately decodes native parent transactions, recomputes their
txids and checks amounts, scripts, owned derivations and change against the
reviewed plan. The gateway checks current inputs, confirmations, coinbase
maturity, fees and `testmempoolaccept` before publication. A broadcast timeout
is an unknown outcome; retry reconciliation uses the identical signed bytes.

The browser keeps a labelled last-known display cache while a fresh read is
pending. Cached balances cannot supply inputs or authorize sending. Local
accepted-transaction projections show pending effects without inventing
confirmations or permission to spend.

Core `txindex` is not an address-history index. A pruned node cannot necessarily
prove old confirmed transaction membership or supply every raw parent. Recovery
still depends on providers retaining the relevant history and bytes. The
gateway's genesis, freshness and parent checks do not independently verify
consensus, completeness or inclusion in the chain.

Providers can correlate queried public addresses, hide activity or refuse
service. Account xpubs and wallet secrets are not sent to them. Read the
[security boundaries](SECURITY.md) for the trust and recovery limits.
