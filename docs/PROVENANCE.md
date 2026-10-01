# Release provenance

`GET /api/build` returns metadata from the manifest written into
`dist/build.json` during compilation. It does not read the current Git HEAD,
accept a commit from runtime environment variables or contact Core. Responses
set `Cache-Control: no-store`.

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Manifest schema, currently `1`. |
| `version` | Version from the source `package.json`. |
| `commit` | Full 40-character Git SHA for clean committed inputs; `null` for dirty or uncommitted development inputs. |
| `dirty` | Whether the build inputs or checkout differ from a clean commit. |
| `release` | Whether the strict release build path was used. |
| `builtAt` | UTC build timestamp in ISO 8601 format. |
| `sourceSha256` | SHA256 of the canonical source file inventory. |

The full manifest additionally stores sorted `sourceFiles` and `distFiles`
arrays of `{path, sha256}` objects. Source paths are relative to the application
root; artifact paths are relative to `dist`. The source aggregate is SHA256 of
the UTF-8 `JSON.stringify(sourceFiles)` representation. Each file hash covers
its exact bytes. The artifact inventory excludes `build.json` itself to avoid a
self-referential hash.

## Building and checking

`npm run build` requires a clean checkout with a committed HEAD. The source
inventory covers the complete published source tree, including gateway code,
package and lock files, Vite configuration, documentation, tests and deployment
templates. Runtime data, installed packages, build outputs, local env values and
ignored test reports are excluded. Inputs must match the committed file
inventory and bytes; ignored extra files and Git `assume-unchanged` flags cannot
hide substituted release inputs. Symbolic-link inputs are rejected.

Git checks disable replacement objects with `--no-replace-objects` and remove
Git routing environment overrides, so a replacement object or alternate
worktree/index environment cannot silently change the committed bytes used for
comparison. These checks use the intended physical checkout and its real HEAD.

The build snapshots Git and source bytes before and after compilation and
rejects a changed source state. It forces `NODE_ENV=production`. Vite's env-file
loading and `VITE_` frontend injection are disabled. Browser dependency notices
and the project license are generated before the artifact hashes are recorded.

`npm run build:dev` allows development states and writes `release:false`.
Dirty or uncommitted inputs use `commit:null` and `dirty:true`; a clean development
build can identify its commit without claiming to be a release.

```bash
# Verify a release build and its clean checkout/HEAD.
npm run verify-build
# Verify a copied deployment tree without requiring .git.
npm run verify-build -- /absolute/path/to/release
# Inspect a development build explicitly.
npm run verify-build -- --development /absolute/path/to/development/tree
# Recheck the exact Git index intended for publication.
npm run check-publication
```

Copy the entire published source tree into a release, together with the complete
`dist` and installed `node_modules`. The verification command compares the
source inventory, package version and all artifact files against the manifest.
Missing, altered or added source/artifact files are rejected. Installed packages
in `node_modules` are outside the ledger. Before every release, the operator
must run a fresh `npm ci` from the pinned lockfile; the build command does not
install dependencies automatically. Preserve the installed packages' license
notices. Source and artifact hashes do not independently
establish the identity or integrity of the installed dependencies or toolchain.

## Gateway startup and release switching

The gateway validates the manifest and source/artifact hashes before serving.
Production startup refuses a missing, malformed, inconsistent or development
manifest. Start local development with `NODE_ENV=development` explicitly.

At startup, the gateway resolves its static directory with `realpath` and pins
that physical directory and the validated public metadata. Replacing a
`current` symlink cannot mix old gateway code with the new release's files.
Metadata remains unchanged during the process lifetime; it is not refreshed
from Git, runtime environment variables or a replacement manifest.

Run copied-tree verification immediately before activation and check the HTTPS
endpoint after restarting. Compare its full commit to the intended repository
commit and confirm `release:true`, `dirty:false` and the no-store header.

## Trust limits

These are operator-supplied metadata, not an independent cryptographic proof of
an honest host. A compromised operator or server can replace both code and
metadata, alter files after startup, lie in HTTP responses or serve different
content to different clients. Matching an endpoint SHA with GitHub alone does
not prove which code the browser executes.

The manifest supports inspection and detection of accidental substitutions
against independently obtained source/artifact hashes. It does not provide
remote attestation, signed third-party build certification, independent proof of
dependency identity, dependency integrity after installation, an honest host or
toolchain, or a guarantee of reproducible artifact bytes. Independent review and
trusted distribution remain necessary.
