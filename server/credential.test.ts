import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreRpc } from './rpc';

const fixture = vi.hoisted(() => ({ paths: new Map<string, { mode: number; uid: number; directory?: boolean; real?: string }>(), reads: vi.fn() }));
vi.mock('node:fs/promises', () => ({
  stat: async (path: string) => { const item = fixture.paths.get(path); if (!item) throw new Error('Fixture path not found'); return { mode: item.mode, uid: item.uid, isFile: () => !item.directory, isDirectory: () => item.directory === true }; },
  realpath: async (path: string) => { const item = fixture.paths.get(path); if (!item) throw new Error('Fixture path not found'); return item.real || path; },
  readFile: async (path: string) => { fixture.reads(path); return 'unit-cookie:unit-password'; },
}));
const directory = '/run/credentials/unit-wallet.service'; const cookie = `${directory}/core.cookie`;
const normal = '/tmp/unit-core.cookie';
function transport(path = cookie) {
  const request = vi.fn(async (_url: unknown, options?: RequestInit) => { const body = JSON.parse(String(options!.body)); return new Response(JSON.stringify({ id: body.id, result: 'unit-result' })); });
  const rpc = new CoreRpc({ network: 'mainnet', rpcUrl: 'http://127.0.0.1:39242', allowedOrigins: ['https://wallet.example'], cookieFile: path, fetch: request as typeof fetch });
  return { rpc, request };
}
beforeEach(() => {
  fixture.paths.clear(); fixture.reads.mockClear();
  fixture.paths.set(directory, { mode: 0o550, uid: 0, directory: true }); fixture.paths.set(cookie, { mode: 0o440, uid: 0 });
  vi.stubEnv('CREDENTIALS_DIRECTORY', directory);
});
afterEach(() => vi.unstubAllEnvs());
describe('pinned systemd credential ACL', () => {
  it('accepts a root-owned 0440 credential in the exact private systemd directory', async () => {
    const { rpc, request } = transport(); expect(await rpc.call('getblockhash', [0])).toBe('unit-result'); expect(request).toHaveBeenCalledTimes(1); expect(fixture.reads).toHaveBeenCalledWith(cookie);
  });
  it('rejects group/world access on a normal cookie even with a credential environment', async () => {
    for (const mode of [0o440, 0o640, 0o444, 0o644, 0o660]) {
      fixture.paths.set(normal, { mode, uid: 0 }); const { rpc, request } = transport(normal);
      await expect(rpc.call('getblockhash', [0])).rejects.toMatchObject({ code: 'rpc-auth-unavailable' }); expect(request).not.toHaveBeenCalled();
    }
    expect(fixture.reads).not.toHaveBeenCalled();
  });
  it('does not accept another filename, an unset environment, or an arbitrary directory', async () => {
    const otherFile = `${directory}/other.cookie`; fixture.paths.set(otherFile, { mode: 0o440, uid: 0 });
    await expect(transport(otherFile).rpc.call('getblockhash', [0])).rejects.toMatchObject({ code: 'rpc-auth-unavailable' });
    vi.stubEnv('CREDENTIALS_DIRECTORY', ''); await expect(transport().rpc.call('getblockhash', [0])).rejects.toMatchObject({ code: 'rpc-auth-unavailable' });
    vi.stubEnv('CREDENTIALS_DIRECTORY', '/tmp/unit-credentials'); fixture.paths.set('/tmp/unit-credentials/core.cookie', { mode: 0o440, uid: 0 });
    await expect(transport('/tmp/unit-credentials/core.cookie').rpc.call('getblockhash', [0])).rejects.toMatchObject({ code: 'rpc-auth-unavailable' });
    expect(fixture.reads).not.toHaveBeenCalled();
  });
  it('rejects a writable/public directory, non-root ownership or symlink substitution', async () => {
    for (const parent of [{ mode: 0o570, uid: 0, directory: true }, { mode: 0o557, uid: 0, directory: true }, { mode: 0o550, uid: 1000, directory: true }, { mode: 0o550, uid: 0, directory: true, real: '/tmp/replaced' }]) {
      fixture.paths.set(directory, parent); await expect(transport().rpc.call('getblockhash', [0])).rejects.toMatchObject({ code: 'rpc-auth-unavailable' });
    }
    fixture.paths.set(directory, { mode: 0o550, uid: 0, directory: true });
    fixture.paths.set(cookie, { mode: 0o440, uid: 1000 }); await expect(transport().rpc.call('getblockhash', [0])).rejects.toMatchObject({ code: 'rpc-auth-unavailable' });
    fixture.paths.set(cookie, { mode: 0o440, uid: 0, real: normal }); await expect(transport().rpc.call('getblockhash', [0])).rejects.toMatchObject({ code: 'rpc-auth-unavailable' });
    expect(fixture.reads).not.toHaveBeenCalled();
  });
  it('continues accepting ordinary private 0400 and 0600 source cookies', async () => {
    for (const mode of [0o400, 0o600]) { fixture.paths.set(normal, { mode, uid: 0 }); expect(await transport(normal).rpc.call('getblockhash', [0])).toBe('unit-result'); }
  });
});
