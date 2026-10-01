import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertUnchanged, inventory, publicMetadata, snapshotSources, validateManifest } from '../server/build.ts';

const root = resolve(import.meta.dirname, '..');
const development = process.argv.slice(2).includes('--development');
if (process.argv.slice(2).some(value => value !== '--development')) throw new Error('Unknown build argument');
const release = !development;
const before = await snapshotSources(root, release);
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('VITE_') && !name.startsWith('GIT_') && !['NODE_OPTIONS', 'NODE_PATH', 'BABEL_ENV'].includes(name)));
env.NODE_ENV = 'production';
function run(script, args = []) {
  const result = spawnSync(process.execPath, [join(root, script), ...args], { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Build step failed: ${script}`);
}
run('node_modules/typescript/bin/tsc', ['--noEmit']);
run('node_modules/vite/bin/vite.js', ['build', '--mode', 'production']);
run('scripts/license-notices.mjs');
await assertUnchanged(root, before, release);
const distFiles = await inventory(join(root, 'dist'), false);
const manifest = validateManifest({ schemaVersion: 1, version: before.version, commit: before.commit, dirty: before.dirty, release, builtAt: new Date().toISOString(), sourceSha256: before.sourceSha256, sourceFiles: before.files, distFiles }, release);
await writeFile(join(root, 'dist', 'build.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
await assertUnchanged(root, before, release);
process.stdout.write(JSON.stringify(publicMetadata(manifest)) + '\n');
