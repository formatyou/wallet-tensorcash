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
process.stdout.write(JSON.stringify({ verified: true, ...publicMetadata(manifest) }) + '\n');
