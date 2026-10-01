import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertUnchanged, digestFiles, inventory, snapshotSources, validateManifest, verifyManifest, type BuildManifest } from '../../server/build';

const temporary: string[] = [];
const repository = resolve(import.meta.dirname, '../..');
const required = ['server/build.ts', 'server/app.ts', 'server/index.ts', 'server/config.ts', 'vite.config.ts', 'package-lock.json'];
async function temp(): Promise<string> { const root = await mkdtemp(join(tmpdir(), 'wallet-build-test-')); temporary.push(root); return root; }
const git = (root: string, ...args: string[]): string => execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
function commit(root: string) { git(root, 'add', '.'); git(root, '-c', 'user.name=Build Test', '-c', 'user.email=build-test@example.invalid', 'commit', '-qm', 'Test fixture'); }
async function sources(withGit = false): Promise<string> {
  const root = await temp(); await mkdir(join(root, 'server')); await mkdir(join(root, 'src'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.1.10' }));
  await writeFile(join(root, '.gitignore'), 'dist/\nnode_modules/\n.env*\n!.env.example\nsrc/ignored.ts\n');
  for (const path of required) await writeFile(join(root, path), '{}\n');
  if (withGit) { git(root, 'init', '-q'); commit(root); }
  return root;
}
async function manifestFor(root: string, release = true): Promise<BuildManifest> {
  const dist = join(root, 'dist'); await mkdir(dist, { recursive: true });
  await writeFile(join(dist, 'index.html'), '<html>build-test</html>');
  await writeFile(join(dist, 'LICENSE.txt'), 'fixture license');
  await writeFile(join(dist, 'THIRD_PARTY_NOTICES.txt'), 'fixture notices');
  const sourceFiles = await inventory(root); const distFiles = await inventory(dist, false);
  const manifest: BuildManifest = { schemaVersion: 1, version: '0.1.10', commit: release ? 'a'.repeat(40) : null, dirty: !release, release, builtAt: '2026-10-01T00:00:00.000Z', sourceSha256: digestFiles(sourceFiles), sourceFiles, distFiles };
  await writeFile(join(dist, 'build.json'), JSON.stringify(manifest)); return manifest;
}
afterEach(async () => { await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function realCheckout(): Promise<string> {
  const root = await temp();
  await cp(repository, root, { recursive: true, filter: source => {
    const path = source.slice(repository.length + 1); return !['.git', '.runtime', '.agents', '.codex', 'node_modules', 'dist', 'artifacts', 'test-results', 'playwright-report', 'coverage', 'docs/evidence'].some(name => path === name || path.startsWith(name + '/'));
  } });
  await symlink(join(repository, 'node_modules'), join(root, 'node_modules')); return root;
}

describe('release source identity', () => {
  it('accepts a clean committed checkout and records its full SHA', async () => {
    const root = await sources(true); const snapshot = await snapshotSources(root, true);
    expect(snapshot.commit).toBe(git(root, 'rev-parse', 'HEAD')); expect(snapshot.dirty).toBe(false); expect(snapshot.sourceSha256).toBe(digestFiles(snapshot.files));
  });
  it('requires Git and a committed HEAD for release', async () => {
    const root = await sources(); await expect(snapshotSources(root, true)).rejects.toThrow('committed checkout');
    git(root, 'init', '-q'); await expect(snapshotSources(root, true)).rejects.toThrow('committed checkout');
  });
  it('reports uncommitted development sources honestly', async () => {
    const root = await sources(); expect(await snapshotSources(root)).toMatchObject({ commit: null, dirty: true });
  });
  it('rejects modified tracked sources', async () => {
    const root = await sources(true); await writeFile(join(root, 'server/app.ts'), 'changed');
    await expect(snapshotSources(root, true)).rejects.toThrow('verified HEAD inputs');
    expect(await snapshotSources(root)).toMatchObject({ commit: null, dirty: true });
  });
  it('rejects staged changes even when worktree bytes match HEAD', async () => {
    const root = await sources(true); const original = await readFile(join(root, 'server/app.ts'));
    await writeFile(join(root, 'server/app.ts'), 'staged'); git(root, 'add', 'server/app.ts'); await writeFile(join(root, 'server/app.ts'), original);
    await expect(snapshotSources(root, true)).rejects.toThrow('verified HEAD inputs');
  });
  it('checks real bytes of assume-unchanged inputs', async () => {
    const root = await sources(true); git(root, 'update-index', '--assume-unchanged', 'server/app.ts'); await writeFile(join(root, 'server/app.ts'), 'hidden-change');
    expect(git(root, 'status', '--porcelain')).toBe(''); await expect(snapshotSources(root, true)).rejects.toThrow('verified HEAD inputs');
  });
  it('checks ignored additions that can affect source compilation', async () => {
    const root = await sources(true); await writeFile(join(root, 'src/ignored.ts'), 'ignored input');
    expect(git(root, 'status', '--porcelain')).toBe(''); await expect(snapshotSources(root, true)).rejects.toThrow('verified HEAD inputs');
  });
  it('rejects git replace objects that map different sources onto an older SHA', async () => {
    const root = await sources(true); const original = git(root, 'rev-parse', 'HEAD');
    await writeFile(join(root, 'server/app.ts'), 'replacement source'); commit(root); const replacement = git(root, 'rev-parse', 'HEAD');
    git(root, 'replace', original, replacement); await writeFile(join(root, '.git/HEAD'), original + '\n');
    expect(git(root, 'status', '--porcelain')).toBe(''); expect(git(root, 'rev-parse', 'HEAD')).toBe(original);
    await expect(snapshotSources(root, true)).rejects.toThrow('verified HEAD inputs');
  });
  it('ignores ambient Git routing and replacement variables', async () => {
    const root = await sources(true); const foreign = await sources(true);
    const before = await snapshotSources(root, true); const previous = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE };
    Object.assign(process.env, { GIT_DIR: join(foreign, '.git'), GIT_WORK_TREE: foreign, GIT_INDEX_FILE: join(foreign, '.git/index') });
    try { expect(await snapshotSources(root, true)).toEqual(before); }
    finally { for (const [name, value] of Object.entries(previous)) if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  });
  it('excludes disabled environment files and generated directories', async () => {
    const root = await sources(true); await writeFile(join(root, '.env.production'), 'VITE_EXAMPLE=fixture'); await mkdir(join(root, 'dist')); await writeFile(join(root, 'dist/generated'), 'output');
    expect((await snapshotSources(root, true)).dirty).toBe(false);
  });
  it('rejects symlinked source inputs', async () => {
    const root = await sources(); await symlink('/dev/null', join(root, 'src/input.ts'));
    await expect(snapshotSources(root)).rejects.toThrow('symbolic links');
  });
  it('detects input changes after compilation', async () => {
    const root = await sources(true); const before = await snapshotSources(root); await writeFile(join(root, 'server/app.ts'), 'changed');
    await expect(assertUnchanged(root, before, false)).rejects.toThrow('changed during compilation');
  });
  it('detects HEAD changes even for a dirty development checkout', async () => {
    const root = await sources(true); await writeFile(join(root, 'src/local.ts'), 'dirty input');
    const before = await snapshotSources(root); git(root, '-c', 'user.name=Build Test', '-c', 'user.email=build-test@example.invalid', 'commit', '--allow-empty', '-qm', 'New HEAD');
    await expect(assertUnchanged(root, before, false)).rejects.toThrow('changed during compilation');
  });
  it('detects index flag changes after compilation', async () => {
    const root = await sources(true); const before = await snapshotSources(root); git(root, 'update-index', '--assume-unchanged', 'server/app.ts');
    await expect(assertUnchanged(root, before, false)).rejects.toThrow('changed during compilation');
  });
});

describe('build manifest validation', () => {
  it('verifies all sources and dist bytes without a Git directory', async () => {
    const root = await sources(); const manifest = await manifestFor(root);
    expect(await verifyManifest(join(root, 'dist'), root)).toEqual(manifest);
  });
  it('rejects missing manifests', async () => { const root = await sources(); await mkdir(join(root, 'dist')); await expect(verifyManifest(join(root, 'dist'), root)).rejects.toThrow(); });
  it('rejects malformed metadata, unknown fields and abbreviated commits', async () => {
    const root = await sources(); const manifest = await manifestFor(root);
    for (const changed of [{ schemaVersion: 2 }, { commit: 'abcdef0' }, { commit: 'a'.repeat(40), dirty: true }, { builtAt: '2026-02-30T00:00:00.000Z' }, { operatorSecret: 'fixture' }]) expect(() => validateManifest({ ...manifest, ...changed }, true)).toThrow();
  });
  it('rejects development metadata in production', async () => {
    const root = await sources(); await manifestFor(root, false); await expect(verifyManifest(join(root, 'dist'), root)).rejects.toThrow('production');
    expect((await verifyManifest(join(root, 'dist'), root, false)).release).toBe(false);
  });
  it('rejects mismatched aggregate source hashes', async () => {
    const root = await sources(); const manifest = await manifestFor(root); expect(() => validateManifest({ ...manifest, sourceSha256: 'b'.repeat(64) })).toThrow('source digest');
  });
  it('rejects unsafe and duplicated ledger paths', async () => {
    const root = await sources(); const manifest = await manifestFor(root);
    for (const path of ['../outside', '/absolute', 'src\\outside', 'src//outside']) expect(() => validateManifest({ ...manifest, distFiles: [{ path, sha256: 'b'.repeat(64) }] })).toThrow();
    expect(() => validateManifest({ ...manifest, distFiles: [manifest.distFiles[0], manifest.distFiles[0]] })).toThrow();
  });
  it('requires gateway, package and license artifact entries', async () => {
    const root = await sources(); const manifest = await manifestFor(root);
    const sourceFiles = manifest.sourceFiles.filter(file => file.path !== 'server/app.ts'); expect(() => validateManifest({ ...manifest, sourceFiles, sourceSha256: digestFiles(sourceFiles) })).toThrow('required source');
    expect(() => validateManifest({ ...manifest, distFiles: manifest.distFiles.filter(file => file.path !== 'LICENSE.txt') })).toThrow('required artifact');
  });
  it('rejects changed gateway and package inputs', async () => {
    for (const path of ['server/app.ts', 'package-lock.json']) {
      const root = await sources(); await manifestFor(root); await writeFile(join(root, path), 'changed'); await expect(verifyManifest(join(root, 'dist'), root)).rejects.toThrow('source files differ');
    }
  });
  it('rejects extra or changed dist artifacts', async () => {
    const root = await sources(); await manifestFor(root); await writeFile(join(root, 'dist/index.html'), 'replaced'); await expect(verifyManifest(join(root, 'dist'), root)).rejects.toThrow('dist files differ');
    await manifestFor(root); await writeFile(join(root, 'dist/extra.js'), 'extra'); await expect(verifyManifest(join(root, 'dist'), root)).rejects.toThrow('dist files differ');
  });
  it('rejects symlinked manifest files', async () => {
    const root = await sources(); await manifestFor(root); await cp(join(root, 'dist/build.json'), join(root, 'manifest-copy.json'));
    await rm(join(root, 'dist/build.json')); await symlink(join(root, 'manifest-copy.json'), join(root, 'dist/build.json')); await expect(verifyManifest(join(root, 'dist'), root)).rejects.toThrow('regular file');
  });
});

describe('actual release builder', () => {
  it('forces production and prevents environment/.env injection while building clean HEAD', async () => {
    const root = await realCheckout();
    const entry = join(root, 'src/main.tsx');
    await writeFile(entry, 'document.documentElement.dataset.provenance = JSON.stringify({ production: import.meta.env.PROD, leaked: import.meta.env.VITE_PROVENANCE_SENTINEL, file: import.meta.env.VITE_FILE_SENTINEL });\n' + await readFile(entry, 'utf8'));
    await writeFile(join(root, '.env.production'), 'VITE_FILE_SENTINEL=PROVENANCE_ENV_FILE_VALUE_8abc\n');
    git(root, 'init', '-q'); commit(root);
    const result = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: root, env: { ...process.env, NODE_ENV: 'development', VITE_PROVENANCE_SENTINEL: 'PROVENANCE_RUNTIME_VALUE_8abc' }, encoding: 'utf8', timeout: 90000, maxBuffer: 4 * 1024 * 1024 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const manifest = await verifyManifest(join(root, 'dist'), root); expect(manifest.release).toBe(true); expect(manifest.commit).toBe(git(root, 'rev-parse', 'HEAD')); expect(manifest.dirty).toBe(false);
    const javascript = (await inventory(join(root, 'dist'), false)).filter(file => file.path.endsWith('.js'));
    const contents = (await Promise.all(javascript.map(file => readFile(join(root, 'dist', file.path), 'utf8')))).join('\n');
    expect(contents).not.toContain('PROVENANCE_ENV_FILE_VALUE_8abc'); expect(contents).not.toContain('PROVENANCE_RUNTIME_VALUE_8abc');
    expect(contents).toMatch(/production:!0/); expect(contents).not.toContain('react.development');
  }, 100000);
  it.each(['source', 'git'])('rejects %s mutation performed during the actual build', async change => {
    const root = await realCheckout();
    const mutation = change === 'source'
      ? "import { appendFile } from 'node:fs/promises'; await appendFile('server/app.ts', '\\n// changed during compilation\\n');\n"
      : "import { readFile, writeFile } from 'node:fs/promises'; await writeFile('.git/HEAD', await readFile('.git/provenance-next-head'));\n";
    await writeFile(join(root, 'scripts/license-notices.mjs'), mutation); git(root, 'init', '-q'); commit(root);
    if (change === 'git') {
      const before = git(root, 'rev-parse', 'HEAD');
      git(root, '-c', 'user.name=Build Test', '-c', 'user.email=build-test@example.invalid', 'commit', '--allow-empty', '-qm', 'Future fixture HEAD');
      const after = git(root, 'rev-parse', 'HEAD'); git(root, 'checkout', '--detach', before);
      await writeFile(join(root, '.git/provenance-next-head'), after + '\n');
    }
    const result = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: root, env: { ...process.env }, encoding: 'utf8', timeout: 90000, maxBuffer: 4 * 1024 * 1024 });
    expect(result.status).not.toBe(0); expect(result.stderr).toMatch(/Build provenance:.*(?:verified HEAD inputs|changed during compilation)/);
    await expect(readFile(join(root, 'dist/build.json'))).rejects.toThrow();
  }, 100000);
});
