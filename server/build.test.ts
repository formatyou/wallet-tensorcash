import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app';
import { digestFiles, inventory, type BuildManifest } from './build';
import type { GatewayConfig } from './config';

const sourceRoot = resolve(import.meta.dirname, '..');
const roots: string[] = []; const apps: FastifyInstance[] = [];
const config = (extra: Partial<GatewayConfig> = {}): GatewayConfig => ({ network: 'mainnet', rpcUrl: 'http://127.0.0.1:39242', allowedOrigins: ['https://wallet.example'], rpc: { call: async () => { throw new Error('RPC must not be called'); } }, ...extra });
async function directory(): Promise<string> { const root = await mkdtemp(join(tmpdir(), 'wallet-gateway-build-test-')); roots.push(root); return root; }
async function release(root: string, title: string): Promise<BuildManifest> {
  await mkdir(root, { recursive: true }); await writeFile(join(root, 'index.html'), `<html>${title}</html>`); await writeFile(join(root, 'LICENSE.txt'), 'fixture'); await writeFile(join(root, 'THIRD_PARTY_NOTICES.txt'), 'fixture');
  const sourceFiles = await inventory(sourceRoot); const version = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8')).version;
  const manifest: BuildManifest = { schemaVersion: 1, version, commit: 'c'.repeat(40), dirty: false, release: true, builtAt: '2026-10-01T00:00:00.000Z', sourceSha256: digestFiles(sourceFiles), sourceFiles, distFiles: await inventory(root, false) };
  await writeFile(join(root, 'build.json'), JSON.stringify(manifest)); return manifest;
}
async function create(extra: Partial<GatewayConfig> = {}): Promise<FastifyInstance> { const app = await buildApp(config(extra)); apps.push(app); return app; }
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe('immutable gateway build endpoint', () => {
  it('returns only public build fields, no-store, and works with unavailable RPC', async () => {
    const root = await directory(); const manifest = await release(root, 'first'); const app = await create({ staticDir: root, requireRelease: true }); const response = await app.inject('/api/build');
    expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({ schemaVersion: 1, version: manifest.version, commit: manifest.commit, dirty: false, release: true, builtAt: manifest.builtAt, sourceSha256: manifest.sourceSha256 });
  });
  it('ignores runtime environment SHA values and returns captured startup metadata', async () => {
    const root = await directory(); const manifest = await release(root, 'first'); const app = await create({ staticDir: root, requireRelease: true });
    const previous = process.env.WALLET_BUILD_SHA; process.env.WALLET_BUILD_SHA = 'd'.repeat(40);
    try {
      await writeFile(join(root, 'build.json'), JSON.stringify({ ...manifest, commit: 'e'.repeat(40) }));
      expect((await app.inject('/api/build')).json().commit).toBe(manifest.commit);
    } finally { if (previous === undefined) delete process.env.WALLET_BUILD_SHA; else process.env.WALLET_BUILD_SHA = previous; }
  });
  it('refuses production without static files or metadata', async () => {
    await expect(create({ requireRelease: true })).rejects.toThrow('Production'); const root = await directory(); await expect(create({ requireRelease: true, staticDir: root })).rejects.toThrow();
  });
  it('refuses substituted dist files at startup', async () => {
    const root = await directory(); await release(root, 'first'); await writeFile(join(root, 'index.html'), 'substitution'); await expect(create({ staticDir: root, requireRelease: true })).rejects.toThrow('dist files differ');
  });
  it('refuses a source ledger that differs from the running gateway', async () => {
    const root = await directory(); const manifest = await release(root, 'first');
    manifest.sourceFiles.find(file => file.path === 'server/app.ts')!.sha256 = '0'.repeat(64);
    manifest.sourceSha256 = digestFiles(manifest.sourceFiles); await writeFile(join(root, 'build.json'), JSON.stringify(manifest));
    await expect(create({ staticDir: root, requireRelease: true })).rejects.toThrow('source files differ');
  });
  it('refuses development metadata at production startup', async () => {
    const root = await directory(); const manifest = await release(root, 'first');
    await writeFile(join(root, 'build.json'), JSON.stringify({ ...manifest, commit: null, release: false, dirty: true }));
    await expect(create({ staticDir: root, requireRelease: true })).rejects.toThrow('production');
  });
  it('enforces production NODE_ENV even when injected config requests development', async () => {
    const previous = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
    try { await expect(create({ requireRelease: false })).rejects.toThrow('Production'); }
    finally { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; }
  });
  it('pins the physical static directory when current symlink changes', async () => {
    const base = await directory(); const first = join(base, 'first'); const second = join(base, 'second'); await release(first, 'old-wallet'); await release(second, 'new-wallet');
    const current = join(base, 'current'); await symlink(first, current); const app = await create({ staticDir: current, requireRelease: true });
    await rm(current); await symlink(second, current);
    expect((await app.inject('/index.html')).body).toContain('old-wallet'); expect((await app.inject('/api/build')).json().commit).toBe('c'.repeat(40));
  });
  it('provides explicit development metadata when development has no build', async () => {
    const response = await (await create({ requireRelease: false })).inject('/api/build'); expect(response.json()).toMatchObject({ schemaVersion: 1, commit: null, dirty: true, release: false });
  });
});
