# TensorCash Wallet

A self-custody browser wallet for native TensorCash (TSC). Keys are generated
locally, the vault is encrypted on the device, and a Web Worker signs
transactions. The gateway receives public addresses and signed transactions;
the recovery phrase and vault password stay in the browser.

The hosted wallet is available at **https://wallettensor.cash**. The source
repository and production runtime are separate. This initial release has not
received an independent security audit. Read the [security and recovery
boundaries](docs/SECURITY.md) before using it.

## Features and scope

- Twelve-word English BIP39 backup and recovery, encrypted backup import/export,
  password changes and automatic locking.
- Native TSC P2WPKH payments, multiple UTXOs, coin selection, fees, send-max,
  receive addresses and QR codes.
- Confirmed and pending balances, transaction history, retry reconciliation and
  an encrypted last-known display cache.
- A same-origin gateway with Core validation, explicit readiness checks, CSP,
  request limits and server-only RPC credentials.

The recovery scheme is `m/84'/1'/0'`, receive branch `0`, change branch `1`,
and an empty additional BIP39 passphrase. The supported address issuance range
is `0..179` per branch. The default mainnet spending policy requires two
confirmations. Assets, ICU and Tensor-specific transaction extensions are
outside the supported scope; Bitcoin Cash transaction formats are not used.

## Development

Use Node.js 24 or later and the pinned `package-lock.json`:

```bash
npm ci
npm run typecheck
npm test
npm run build:dev
cp .env.example .env
chmod 600 .env
# Fill in your own server-only Core credentials in .env.
node --env-file=.env --import tsx server/index.ts
# In another terminal, start Vite with its loopback /api proxy.
npm run dev
```

The development manifest identifies its actual source state and sets
`release:false`. Do not use it as a production release. Frontend configuration
does not load `.env` or inject `VITE_` values. The gateway accepts an explicitly
configured private Core cookie or server-side RPC credentials.

## Verification and releases

```bash
npm run typecheck
npm test
npm run build:dev
# Inspect the exact Git index intended for publication.
npm run check-publication
# After the audited changes are committed and the checkout is clean:
npm run build
npm run verify-build
```

`npm run build` requires committed inputs matching `HEAD`, checks them before
and after compilation, and forces production frontend compilation. It writes
`dist/build.json`; the gateway validates that manifest when it starts.
`GET /api/build` exposes immutable build metadata independently of Core and
returns `Cache-Control: no-store`. See [release provenance](docs/PROVENANCE.md)
and [operations](docs/OPERATIONS.md) for deployment and verification.

Browser signing tests require an isolated TensorCash Core regtest on loopback
port `19453`. Provide a compatible Core image, then run:

```bash
mkdir -p .runtime/regtest
# Default image runs as UID/GID 10001; adapt to your image's Config.User.
sudo chown 10001:10001 .runtime/regtest
docker compose -f deploy/regtest.yml up -d
npx tsx scripts/signing-gate.ts
npx playwright install chromium firefox webkit
npm run test:e2e
```

The regtest fixtures check their network and genesis before funding or sending.
They use local test coins. Override `TENSORCASH_REGTEST_IMAGE` for a compatible
image and `WALLET_REGTEST_COOKIE` for a different private fixture cookie path.
Production smoke scripts require an explicit HTTPS
origin and perform read-only mainnet checks. Reports go to ignored
`artifacts/evidence`; test results and production runtime data are not source
files intended for publication.

See the [gateway API](server/README.md), [provider model](docs/PROVIDER.md), and
[MIT license](LICENSE). Builds include the project license and the browser
dependency notices; installed server packages retain their own notices.
