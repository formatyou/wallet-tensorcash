import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CoreRpc, readBounded } from './rpc';
import type { GatewayConfig } from './config';
import { GatewayError, RpcError } from './errors';
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const config = (fetch: typeof globalThis.fetch, extra: Partial<GatewayConfig> = {}): GatewayConfig => ({ network: 'mainnet', rpcUrl: 'http://127.0.0.1:39242', rpcUsername: 'unit-user', rpcPassword: 'unit-password', allowedOrigins: ['https://wallet.example'], fetch, ...extra });
describe('bounded server-only Core transport', () => {
  it('never relays signing/private-key RPC methods or arbitrary wallet URLs', async () => {
    const fetch = vi.fn(); const rpc = new CoreRpc(config(fetch as typeof globalThis.fetch));
    await expect(rpc.call('walletpassphrase', ['unit-secret', 1])).rejects.toMatchObject({ code: 'rpc-method-denied' });
    await expect(rpc.call('dumpprivkey', ['address'])).rejects.toMatchObject({ code: 'rpc-method-denied' });
    await expect(rpc.call('getblockchaininfo', [], 'bridge-deposits')).rejects.toMatchObject({ code: 'rpc-wallet-denied' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('refuses watch mutations on a bridge port even with a directly constructed transport', async () => {
    const fetch = vi.fn(); const rpc = new CoreRpc(config(fetch as typeof globalThis.fetch, { network: 'regtest', rpcUrl: 'http://127.0.0.1:19443' }));
    await expect(rpc.call('importdescriptors', [[{ desc: 'addr(public)#checksum' }]], 'wallet-web-watch')).rejects.toMatchObject({ code: 'rpc-wallet-denied' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('uses JSON identity matching and disallows redirected authenticated requests', async () => {
    const fetch = vi.fn(async (_url: unknown, options?: RequestInit) => {
      expect(options?.redirect).toBe('error'); expect(options?.signal).toBeInstanceOf(AbortSignal);
      const body = JSON.parse(String(options?.body)); return new Response(JSON.stringify({ id: body.id + 1, result: {} }));
    });
    await expect(new CoreRpc(config(fetch as typeof globalThis.fetch)).call('getblockchaininfo')).rejects.toMatchObject({ code: 'rpc-invalid-response' });
  });
  it('accepts private 0400 LoadCredential cookies and rereads rotated values', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wallet-rpc-test-')); directories.push(directory); const cookie = join(directory, 'core.cookie');
    await writeFile(cookie, 'unit-cookie:first', { mode: 0o400 });
    const authorizations: string[] = [];
    const fetch = vi.fn(async (_url: unknown, options?: RequestInit) => {
      authorizations.push((options!.headers as Record<string, string>).Authorization);
      const body = JSON.parse(String(options!.body)); return new Response(JSON.stringify({ id: body.id, result: 1 }));
    });
    const rpc = new CoreRpc(config(fetch as typeof globalThis.fetch, { cookieFile: cookie }));
    expect(await rpc.call('getblockhash', [0])).toBe(1);
    await chmod(cookie, 0o600); await writeFile(cookie, 'unit-cookie:second'); await chmod(cookie, 0o400);
    expect(await rpc.call('getblockhash', [0])).toBe(1);
    expect(authorizations[0]).not.toEqual(authorizations[1]);
    await chmod(cookie, 0o644); await expect(rpc.call('getblockhash', [0])).rejects.toMatchObject({ code: 'rpc-auth-unavailable' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('preserves expected RPC error codes without exposing transport failures', async () => {
    const fetch = vi.fn(async (_url: unknown, options?: RequestInit) => { const body = JSON.parse(String(options!.body)); return new Response(JSON.stringify({ id: body.id, error: { code: -5, message: 'No such transaction' } }), { status: 500 }); });
    await expect(new CoreRpc(config(fetch as typeof globalThis.fetch)).call('getrawtransaction', ['0'.repeat(64)])).rejects.toBeInstanceOf(RpcError);
    const unavailable = vi.fn(async () => { throw new Error('unit-password must never be returned'); });
    try { await new CoreRpc(config(unavailable as typeof globalThis.fetch)).call('getblockchaininfo'); throw new Error('Expected failure'); }
    catch (error) { expect(error).toBeInstanceOf(GatewayError); expect((error as Error).message).not.toContain('unit-password'); }
  });
  it('bounds declared and streamed response bodies', async () => {
    await expect(readBounded(new Response('abc', { headers: { 'content-length': '1000' } }), 5)).rejects.toMatchObject({ code: 'provider-response-too-large' });
    await expect(readBounded(new Response('abcdef'), 5)).rejects.toMatchObject({ code: 'provider-response-too-large' });
  });
});
