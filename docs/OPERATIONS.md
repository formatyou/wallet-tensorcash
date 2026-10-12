# Hosting and operations

The published checkout contains application sources, tests and deployment
templates. Keep Core data, RPC credentials, wallet databases, TLS keys, service
environment files, logs, backups and release directories outside it.

Use a dedicated unprivileged gateway user and a loopback RPC connection. The
gateway exposes an allowlisted API, but its Core credentials retain the
capabilities of the underlying RPC endpoint. Do not share a funded service's
wallet data or credentials with this application.

## Configure the gateway

Copy `.env.example` for local development. For a service, maintain a protected
environment file outside the checkout, for example `/etc/tensorcash-wallet.env`.
Set `NODE_ENV=production`, `WALLET_HOST=127.0.0.1`, `WALLET_PORT=8790`, the exact
HTTPS `WALLET_ALLOWED_ORIGINS`, `WALLET_STATIC_DIR` and `CORE_RPC_URL`. Configure
your own private `CORE_COOKIE_FILE` or both `CORE_RPC_USER` and
`CORE_RPC_PASSWORD`. There is no production credential fallback.

Source Core cookies must have mode `0400` or `0600`. With systemd, prefer
`LoadCredential=core.cookie:/absolute/path/to/private/core.cookie` and
`Environment=CORE_COOKIE_FILE=%d/core.cookie`. The narrowly validated systemd
credential copy can be root-owned `0440` with the service ACL; do not loosen the
permissions of the original cookie. Never put credentials in Git or frontend
environment variables.

Review every template under `deploy/` for your own paths and domain. The
systemd unit assumes Node.js 24+ at `/usr/bin/node`; replace that executable
path if your installation differs. Install the service user, environment file
and `LoadCredential` drop-in separately. The credential path watcher must
observe your actual source cookie and restart the gateway after rotation.

Publish the frontend and `/api` under the same HTTPS origin. The nginx template
uses `wallet.example.com` and loopback port `8790`; substitute your hostname and
certificate paths. Preserve your existing TLS and reverse-proxy configuration
when updating an installation. The edge proxy must overwrite
`X-Forwarded-For` with the client's address. Keep Core RPC private.

## Prepare and install a release

Use a clean checkout of the exact published commit and Node.js 24+:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run verify-build
```

`dist/build.json` records the source commit and SHA256 inventories. Preserve the
complete verified application tree in a new release directory, including
all published sources, docs, deployment templates, hidden config files, the
entire `dist`, and installed packages with their license notices.
Keep credentials and Core data outside that directory. Do not copy files from
an older running release into it after verification.

Verify the copied tree again with `npm run verify-build -- /absolute/path/to/release`
before activating it. For an installation with
the existing service and configuration already prepared, the activation helper
can switch an assembled release:

```bash
sudo bash scripts/deploy-systemd.sh /opt/tensorcash-wallet/releases/RELEASE_ID
```

The helper verifies the release, switches `current` atomically, restarts the
service and checks all `/api/build` metadata and its no-store header on loopback
within 30 seconds. Override `WALLET_ACTIVATION_ORIGIN` for a different loopback
HTTP(S) port and `NODE` for a custom Node.js 24+ executable. Core readiness does
not gate activation. A failed start or metadata check restores the previous
link. The helper preserves environment, TLS and Core configuration. Coordinate
any nginx or service-unit changes separately. Record the previous release for
rollback.

The gateway resolves its static directory to a physical path at startup and
pins the validated manifest. Switching `current` does not cause the running
process to combine its old sources with a new release's assets; restart the
gateway after activation.

## Release tags and third-party attestation

Every release commit carries the new `package.json` version and an annotated
tag `vX.Y.Z` on that exact commit. Push the commit and the tag to every public
copy of this repository (for the hosted wallet: GitHub and
`git.tensorcash.org/tsc.watch/wallettensor.cash`); tags on one remote only are
not discovered.

The hosted wallet is listed in TensorCash Code Verify
(`https://integrity.tensorcash.org/verify/`). Its signed manifest covers the
files served to the browser from `dist`, not `/api` responses, the gateway or
chain data. Releases that change browser-served bytes are tagged and pushed
first; after the signed manifest for that tag is published, compare its file
hashes with `dist/build.json` of the assembled release, then activate it.
Releases whose `dist` hashes are unchanged (gateway-only changes) can be
activated before the tag is pushed. For an urgent security fix that changes
browser bytes, push the tag, notify the attestor and activate immediately;
until the manifest is published the extension reports the build as unsigned.

Tell the attestor before changing `scripts/build.mjs`, `vite.config.ts` or
`server/build.ts`; their build recipe pins them, and `npm run verify-build`
refuses a release whose pinned files differ from `scripts/code-verify-pins.json`.

## Read-only production checks

```bash
curl --fail --include https://wallet.example.com/api/build
curl --fail https://wallet.example.com/api/v1/network
curl --fail https://wallet.example.com/health
```

Compare the full build commit with the repository commit, verify
`release:true` and `dirty:false`, and check `Cache-Control: no-store`. Check the
manifest's source and asset hashes against the assembled release. Build metadata
must remain available even when Core is unavailable. `/health` depends on chain
and index readiness and can return `503` during synchronization.

### Serving invariants

Third-party integrity checkers compare the files the site sends with a signed
build of the release tag, byte for byte. Serve `dist` unchanged: no CDN or proxy
feature that rewrites HTML, JavaScript or CSS (minification, script or analytics
injection, `sub_filter`, SSI). Transport compression is fine; browsers decode it
before comparing. The entry page and other static files must return
`Cache-Control: no-cache` with an `ETag`; `/api/*` and `/health` return
`no-store`. Static `ETag`s are `W/"size-mtime"` and `index.html` keeps the same
size across releases, so never normalize or copy `dist` modification times
between builds. After activation, compare every manifest artifact with the
public origin:

```bash
cd /opt/tensorcash-wallet/current/dist && ORIGIN=https://wallet.example.com node -e '
const m = require("./build.json"); const { createHash } = require("node:crypto");
const sha = b => createHash("sha256").update(b).digest("hex");
(async () => { let bad = 0; const entry = m.distFiles.find(f => f.path === "index.html").sha256;
  for (const [url, want, accept] of [...m.distFiles.map(f => ["/" + f.path, f.sha256, "*/*"]), ["/", entry, "text/html"]]) {
    const r = await fetch(process.env.ORIGIN + url, { headers: { accept } });
    const ok = r.ok && sha(Buffer.from(await r.arrayBuffer())) === want; bad += !ok;
    console.log(ok ? "ok  " : "DIFF", url, r.headers.get("cache-control"));
  } process.exit(bad ? 1 : 0); })();'
```

Production browser checks can be directed at your own HTTPS origin:

```bash
WALLET_SMOKE_ORIGIN=https://wallet.example.com npx tsx scripts/production-smoke.ts
```

The script checks metadata, headers and the landing UI using GET requests only.
It does not create, unlock, fund or spend from a wallet. Other UI smoke scripts
use the same explicit origin setting; consult their scope before running them.
Signing and transaction tests belong only on the isolated regtest fixture.

## Certificates and rollback

Keep ACME renewal outside the source checkout. The provided renewal service
uses the system `certbot` and reloads nginx after renewal; adapt it to your TLS
terminator. Validate nginx configuration before reloading it.

To roll back, point `current` at the previous complete verified release and
restart the gateway. Preserve the production environment file, Core data,
cookie source and certificates. Local browser vaults and backups belong to
users; deploying or rolling back the application does not migrate their data.
