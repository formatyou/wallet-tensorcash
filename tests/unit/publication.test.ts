import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
// @ts-expect-error The standalone publication auditor intentionally runs as plain Node ESM.
import { auditPublication } from '../../scripts/check-publication.mjs';

const repositories: string[] = [];
afterEach(() => repositories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
function repository() {
  const cwd = mkdtempSync(join(tmpdir(), 'wallet-publication-test-'));
  repositories.push(cwd);
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.name', 'Publication Test');
  git('config', 'user.email', 'publication-test@example.invalid');
  const stage = (path: string, content: string | Buffer) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
    git('add', '-f', '--', path);
  };
  return { cwd, git, stage, audit: (head = false) => auditPublication({ cwd, head }) };
}
const token = () => ['gh', 'p_', 'A'.repeat(30)].join('');
const fixture = () => readFileSync(resolve('tests/fixtures/bip39-english.json'));
const phrase = () => JSON.parse(fixture().toString()).vectors[0].mnemonic as string;

describe('publication snapshot audit', () => {
  it('reads staged blobs even when the worktree becomes sensitive', () => {
    const repo = repository(); repo.stage('README.md', 'Public instructions.\n');
    writeFileSync(join(repo.cwd, 'README.md'), token());
    expect(repo.audit()).toMatchObject({ ok: true, files: 1, snapshot: 'index' });
  });

  it('rejects staged secrets even when the worktree has been cleaned', () => {
    const repo = repository(); repo.stage('README.md', token());
    writeFileSync(join(repo.cwd, 'README.md'), 'Public instructions.\n');
    const result = repo.audit();
    expect(result.findings).toContainEqual({ path: 'README.md', category: 'service-token' });
    expect(JSON.stringify(result)).not.toContain(token());
  });

  it('audits HEAD independently of staged and worktree changes', () => {
    const repo = repository(); repo.stage('README.md', 'Public instructions.\n'); repo.git('commit', '-qm', 'fixture');
    repo.stage('README.md', token());
    expect(repo.audit(true)).toMatchObject({ ok: true, snapshot: 'HEAD' });
    expect(repo.audit().ok).toBe(false);
  });

  it('does not let Git replacement objects hide a staged secret', () => {
    const repo = repository(); repo.stage('notes.txt', token());
    const sensitiveBlob = repo.git('rev-parse', ':notes.txt').toString().trim();
    repo.stage('safe.txt', 'Public instructions.\n');
    const safeBlob = repo.git('rev-parse', ':safe.txt').toString().trim();
    repo.git('replace', sensitiveBlob, safeBlob);
    expect(repo.audit().findings).toContainEqual({ path: 'notes.txt', category: 'service-token' });
  });

  it('does not let an alternate Git index hide a staged secret', () => {
    const repo = repository(); repo.stage('notes.txt', token());
    const previous = process.env.GIT_INDEX_FILE;
    process.env.GIT_INDEX_FILE = join(repo.cwd, 'empty-index');
    try { expect(repo.audit().findings).toContainEqual({ path: 'notes.txt', category: 'service-token' }); }
    finally { if (previous === undefined) delete process.env.GIT_INDEX_FILE; else process.env.GIT_INDEX_FILE = previous; }
  });

  it('rejects runtime, credentials, databases, archives and historical evidence by path', () => {
    const repo = repository();
    const paths = ['node_modules/module.js', 'dist/index.html', 'artifacts/result.json', 'test-results/output.json',
      'docs/evidence/history.json', '.env.production', 'wallet.dat', 'db.sqlite', 'server.log', 'backup/source.tar.gz'];
    paths.forEach(path => repo.stage(path, 'placeholder'));
    const result = repo.audit();
    expect(result.ok).toBe(false);
    expect(new Set(result.findings.map((finding: { path: string }) => finding.path))).toEqual(new Set(paths));
  });

  it('rejects symlinks rather than following files outside the snapshot', () => {
    const repo = repository(); symlinkSync('README.md', join(repo.cwd, 'link'));
    repo.git('add', 'link');
    expect(repo.audit().findings).toContainEqual({ path: 'link', category: 'symlink-or-submodule' });
  });

  it('permits only the exact reviewed public fixture', () => {
    const repo = repository(); repo.stage('tests/fixtures/bip39-english.json', fixture());
    expect(repo.audit().ok).toBe(true);
    repo.stage('tests/fixtures/bip39-english.json', Buffer.concat([fixture(), Buffer.from('\n')]));
    expect(repo.audit().findings).toContainEqual({ path: 'tests/fixtures/bip39-english.json', category: 'changed-public-vector-fixture' });
  });

  it('limits public mnemonic exemptions to reviewed test paths and phrase hashes', () => {
    const repo = repository(); repo.stage('tests/unit/core.test.ts', `const MNEMONIC = ${JSON.stringify(phrase())};\n`);
    expect(repo.audit().ok).toBe(true);
    repo.stage('operator-notes.txt', phrase());
    expect(repo.audit().findings).toContainEqual({ path: 'operator-notes.txt', category: 'unreviewed-wallet-mnemonic' });
    const unreviewed = entropyToMnemonic(new Uint8Array(16).fill(3), wordlist);
    repo.stage('tests/unit/core.test.ts', unreviewed);
    expect(repo.audit().findings).toContainEqual({ path: 'tests/unit/core.test.ts', category: 'unreviewed-wallet-mnemonic' });
  });

  it('limits mock credential exemptions to the exact path and reviewed line', () => {
    const repo = repository();
    const line = readFileSync(resolve('server/rpc.test.ts'), 'utf8').split('\n')[9];
    repo.stage('server/rpc.test.ts', line + '\n');
    expect(repo.audit().ok).toBe(true);
    repo.stage('other.test.ts', line + '\n');
    expect(repo.audit().findings).toContainEqual({ path: 'other.test.ts', category: 'credential-literal' });
    repo.stage('server/rpc.test.ts', line + ' // altered context\n');
    expect(repo.audit().findings).toContainEqual({ path: 'server/rpc.test.ts', category: 'credential-literal' });
  });

  it('finds keys, credential URLs, operator paths and IPs without returning values', () => {
    const repo = repository();
    const content = [
      ['-----BEGIN ', 'PRIVATE KEY-----'].join(''),
      ['https://', 'operator:', 'credential@', 'example.invalid'].join(''),
      ['/', 'root', '/operator/runtime'].join(''),
      [203, 0, 113, 25].join('.'),
    ].join('\n');
    repo.stage('notes.txt', content);
    const result = repo.audit();
    expect(new Set(result.findings.map((finding: { category: string }) => finding.category))).toEqual(new Set([
      'private-key-block', 'credential-url', 'operator-home-path', 'operator-network-address',
    ]));
    expect(JSON.stringify(result)).not.toContain(content);
  });

  it('permits blank and placeholder environment examples and rejects assigned secrets', () => {
    const repo = repository();
    const key = ['CORE', 'RPC', 'PASSWORD'].join('_');
    repo.stage('.env.example', `${key}=\n`);
    expect(repo.audit().ok).toBe(true);
    repo.stage('.env.example', `${key}=<provided-by-operator>\n`);
    expect(repo.audit().ok).toBe(true);
    repo.stage('.env.example', `${key}=private-value\n`);
    expect(repo.audit().findings).toContainEqual({ path: '.env.example', category: 'credential-environment-value' });
  });

  it('rejects unknown binaries and an empty publication snapshot', () => {
    const repo = repository();
    expect(repo.audit().findings).toContainEqual({ path: '<snapshot>', category: 'empty-snapshot' });
    repo.stage('unknown.bin', Buffer.from([0, 1, 2, 3]));
    expect(repo.audit().findings).toContainEqual({ path: 'unknown.bin', category: 'unreviewed-binary' });
  });

  it('CLI reports only findings and exits unsuccessfully for a sensitive snapshot', () => {
    const repo = repository(); repo.stage('notes.txt', token());
    let stdout = ''; let status = 0;
    try { stdout = execFileSync(process.execPath, [resolve('scripts/check-publication.mjs')], { cwd: repo.cwd, encoding: 'utf8', stdio: 'pipe' }); }
    catch (error) { const failure = error as { stdout: string; status: number }; stdout = failure.stdout; status = failure.status; }
    expect(status).toBe(1); expect(JSON.parse(stdout).ok).toBe(false);
    expect(stdout).not.toContain(token());
  });
});
