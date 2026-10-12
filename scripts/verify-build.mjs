import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { publicMetadata, snapshotSources, verifyManifest } from '../server/build.ts';

const arguments_ = process.argv.slice(2);
const development = arguments_.includes('--development');
const roots = arguments_.filter(value => value !== '--development');
if (roots.length > 1 || roots.some(value => value.startsWith('--'))) throw new Error('Usage: verify-build.mjs [--development] [release-directory]');
const root = resolve(roots[0] || resolve(import.meta.dirname, '..'));
const manifest = await verifyManifest(resolve(root, 'dist'), root, !development);
// A checkout can additionally check the source ledger against its committed
// bytes; deployed releases need no .git directory and never read runtime HEAD.
if (!development && roots.length === 0) {
  const snapshot = await snapshotSources(root, true);
  if (snapshot.commit !== manifest.commit || snapshot.sourceSha256 !== manifest.sourceSha256) throw new Error('Build manifest does not match clean checkout HEAD');
}
// TensorCash Code Verify signs releases with a recipe that pins the build files
// listed in scripts/code-verify-pins.json; a changed pinned file cannot be
// signed until they have reviewed it. Refuse such a release tree here and update
// the pin file only in the same commit as the reviewed change.
const pins = JSON.parse(await readFile(resolve(root, 'scripts', 'code-verify-pins.json'), 'utf8'));
for (const [path, expected] of Object.entries(pins.files)) {
  const actual = manifest.sourceFiles.find(file => file.path === path)?.sha256 ?? 'missing';
  if (actual === expected) continue;
  const message = `Code Verify pinned build file changed since ${pins.reviewedTag}: ${path} (expected ${expected}, found ${actual}). Notify Code Verify and update scripts/code-verify-pins.json in the same commit.`;
  if (!development) throw new Error(message);
  process.stderr.write(`Warning: ${message}\n`);
}
process.stdout.write(JSON.stringify({ verified: true, ...publicMetadata(manifest) }) + '\n');
