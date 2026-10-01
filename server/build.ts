import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

export interface FileDigest { path: string; sha256: string; }
export interface BuildMetadata {
  schemaVersion: 1; version: string; commit: string | null; dirty: boolean;
  release: boolean; builtAt: string; sourceSha256: string;
}
export interface BuildManifest extends BuildMetadata { sourceFiles: FileDigest[]; distFiles: FileDigest[]; }
export interface SourceSnapshot { files: FileDigest[]; sourceSha256: string; commit: string | null; dirty: boolean; version: string; gitState: string | null; }

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const EXCLUDED = new Set(['.git', 'node_modules', 'dist', 'artifacts', 'test-results', 'playwright-report', 'coverage', '.agents', '.codex', '.runtime', 'runtime', 'logs', 'backups']);
const sourceExcluded = (path: string) => EXCLUDED.has(path.split('/')[0]) || path === 'docs/evidence' || path.startsWith('docs/evidence/') || (path.startsWith('.env') && path !== '.env.example');
export const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
export const digestFiles = (files: FileDigest[]): string => sha256(JSON.stringify(files));
function fail(message: string): never { throw new Error(`Build provenance: ${message}`); }

// Walk the real bytes, including ignored and assume-unchanged files. Git's
// status/index flags are insufficient to establish build input identity.
export async function inventory(root: string, sources = true): Promise<FileDigest[]> {
  const files: FileDigest[] = [];
  async function walk(directory: string) {
    for (const entry of (await readdir(directory)).sort()) {
      const absolute = join(directory, entry); const path = relative(root, absolute).split(sep).join('/');
      if ((sources && sourceExcluded(path)) || (!sources && path === 'build.json')) continue;
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) fail(`symbolic links are not allowed in build inputs: ${path}`);
      if (info.isDirectory()) await walk(absolute);
      else if (info.isFile()) files.push({ path, sha256: sha256(await readFile(absolute)) });
      else fail(`unsupported file type: ${path}`);
    }
  }
  await walk(root);
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
function git(root: string, args: string[]): Buffer {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  return execFileSync('git', ['--no-replace-objects', '-C', root, '-c', 'core.fsmonitor=false', ...args], { env, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}
export async function snapshotSources(root: string, release = false): Promise<SourceSnapshot> {
  root = await realpath(root);
  const files = await inventory(root);
  const packageFile = files.find(file => file.path === 'package.json'); if (!packageFile) fail('package.json is missing');
  const version: unknown = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) fail('package version is invalid');
  let commit: string | null = null; let dirty = true; let gitState: string | null = null;
  try {
    if (await realpath(git(root, ['rev-parse', '--show-toplevel']).toString().trim()) !== root) fail('build requires the checkout root');
    const status = git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
    let rawHead: Buffer; try { rawHead = git(root, ['rev-parse', '--verify', 'HEAD']); } catch { rawHead = Buffer.from('unborn'); }
    gitState = sha256(Buffer.concat([rawHead, status, git(root, ['ls-files', '--stage', '-z']), git(root, ['ls-files', '-v', '-z'])]));
    const head = git(root, ['rev-parse', '--verify', 'HEAD']).toString().trim(); if (!COMMIT.test(head)) fail('full Git commit is invalid');
    const entries = git(root, ['ls-tree', '-r', '-z', 'HEAD']).toString().split('\0').filter(Boolean);
    const expected: FileDigest[] = [];
    for (const entry of entries) {
      const tab = entry.indexOf('\t'); const path = entry.slice(tab + 1); if (sourceExcluded(path)) continue;
      const [mode, type, object] = entry.slice(0, tab).split(' ');
      if (type !== 'blob' || !['100644', '100755'].includes(mode)) fail(`unsupported committed input: ${path}`);
      expected.push({ path, sha256: sha256(git(root, ['cat-file', 'blob', object])) });
    }
    expected.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const cleanInputs = JSON.stringify(files) === JSON.stringify(expected);
    dirty = !cleanInputs || status.length > 0;
    if (!dirty) commit = head;
    if (release && dirty) fail('release requires a clean, committed checkout and every input must match HEAD (including ignored files)');
  } catch (error) {
    if (release) throw new Error('Build provenance: release requires a clean, committed checkout with verified HEAD inputs', { cause: error });
    commit = null; dirty = true;
  }
  return { files, sourceSha256: digestFiles(files), version, commit, dirty, gitState };
}
export async function assertUnchanged(root: string, before: SourceSnapshot, release: boolean): Promise<void> {
  const after = await snapshotSources(root, release);
  if (JSON.stringify(before) !== JSON.stringify(after)) fail('Git or build inputs changed during compilation');
}
function validPath(path: unknown): path is string {
  return typeof path === 'string' && path.length > 0 && path.length < 1024 && !path.includes('\\') && !path.includes('\0') && !path.startsWith('/') && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}
function validateLedger(value: unknown, source: boolean): FileDigest[] {
  if (!Array.isArray(value) || !value.length || value.length > 20000) fail('file ledger is invalid');
  let previous = '';
  return value.map(entry => {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).sort().join(',') !== 'path,sha256' || !validPath(entry.path) || !SHA256.test(entry.sha256) || entry.path <= previous || (source ? sourceExcluded(entry.path) : entry.path === 'build.json')) fail('file ledger entry is invalid');
    previous = entry.path;
    return { path: entry.path, sha256: entry.sha256 };
  });
}
export function validateManifest(value: unknown, requireRelease = false): BuildManifest {
  if (!value || typeof value !== 'object') fail('manifest is invalid');
  const manifest = value as BuildManifest;
  const keys = ['schemaVersion', 'version', 'commit', 'dirty', 'release', 'builtAt', 'sourceSha256', 'sourceFiles', 'distFiles'];
  if (Object.keys(manifest).sort().join(',') !== keys.sort().join(',') || manifest.schemaVersion !== 1 || typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version) || !(manifest.commit === null || (typeof manifest.commit === 'string' && COMMIT.test(manifest.commit))) || typeof manifest.dirty !== 'boolean' || typeof manifest.release !== 'boolean' || typeof manifest.builtAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(manifest.builtAt) || !Number.isFinite(Date.parse(manifest.builtAt)) || new Date(manifest.builtAt).toISOString() !== manifest.builtAt || !SHA256.test(manifest.sourceSha256)) fail('manifest metadata is invalid');
  if (manifest.release && (manifest.dirty || !manifest.commit)) fail('release metadata is inconsistent');
  if (manifest.dirty && manifest.commit !== null) fail('dirty metadata must not claim a commit');
  if (requireRelease && (!manifest.release || manifest.dirty || !manifest.commit)) fail('production requires release metadata');
  const sourceFiles = validateLedger(manifest.sourceFiles, true); const distFiles = validateLedger(manifest.distFiles, false);
  if (digestFiles(sourceFiles) !== manifest.sourceSha256) fail('source digest does not match ledger');
  for (const path of ['package.json', 'package-lock.json', 'server/build.ts', 'server/app.ts', 'server/index.ts', 'server/config.ts', 'vite.config.ts']) if (!sourceFiles.some(file => file.path === path)) fail(`required source is missing: ${path}`);
  for (const path of ['index.html', 'LICENSE.txt', 'THIRD_PARTY_NOTICES.txt']) if (!distFiles.some(file => file.path === path)) fail(`required artifact is missing: ${path}`);
  return { ...manifest, sourceFiles, distFiles };
}
export async function verifyManifest(staticRoot: string, sourceRoot: string, requireRelease = true): Promise<BuildManifest> {
  staticRoot = await realpath(staticRoot); sourceRoot = await realpath(sourceRoot);
  const manifestPath = join(staticRoot, 'build.json');
  if (!(await lstat(manifestPath)).isFile()) fail('manifest must be a regular file');
  const manifest = validateManifest(JSON.parse(await readFile(manifestPath, 'utf8')), requireRelease);
  const [sources, artifacts] = await Promise.all([inventory(sourceRoot), inventory(staticRoot, false)]);
  if (JSON.stringify(sources) !== JSON.stringify(manifest.sourceFiles)) fail('source files differ from build manifest');
  if (JSON.stringify(artifacts) !== JSON.stringify(manifest.distFiles)) fail('dist files differ from build manifest');
  const pkg = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'));
  if (pkg.version !== manifest.version) fail('package version differs from build manifest');
  return manifest;
}
export function publicMetadata(manifest: BuildMetadata): Readonly<BuildMetadata> {
  const { schemaVersion, version, commit, dirty, release, builtAt, sourceSha256 } = manifest;
  return Object.freeze({ schemaVersion, version, commit, dirty, release, builtAt, sourceSha256 });
}
