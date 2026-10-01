import { readFile, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Stats } from 'node:fs';
import type { GatewayConfig } from './config';
import { GatewayError, RpcError } from './errors';

export interface Rpc { call<T = unknown>(method: string, params?: unknown[], wallet?: string): Promise<T>; }
const READ_METHODS = new Set(['getblockchaininfo', 'getblockhash', 'getblockheader', 'getmempoolinfo', 'getrawmempool', 'estimatesmartfee', 'gettxout', 'getrawtransaction', 'decodeassettransaction', 'decoderawtransaction', 'testmempoolaccept', 'validateaddress', 'getmempoolentry']);
const WATCH_METHODS = new Set(['createwallet', 'loadwallet', 'getwalletinfo', 'getdescriptorinfo', 'listdescriptors', 'importdescriptors', 'listtransactions', 'listsinceblock', 'gettransaction', 'listunspent']);
async function isPrivateSystemdCredential(cookieFile: string, file: Stats): Promise<boolean> {
  // Some systemd hosts grant the service a named read-only ACL. Its ACL mask
  // appears as group-read in stat(2), although the owning group has no access.
  // Accept that only at the exact systemd-provided, root-owned credential path.
  if ((file.mode & 0o777) !== 0o440 || file.uid !== 0) return false;
  const configuredDirectory = process.env.CREDENTIALS_DIRECTORY;
  if (!configuredDirectory) return false;
  const directory = resolve(configuredDirectory); const pinnedFile = join(directory, 'core.cookie');
  if (!directory.startsWith('/run/credentials/') || resolve(cookieFile) !== pinnedFile) return false;
  const parent = await stat(directory);
  if (!parent.isDirectory() || parent.uid !== 0 || (parent.mode & 0o027) !== 0) return false;
  return await realpath(directory) === directory && await realpath(cookieFile) === pinnedFile;
}
export async function readBounded(response: Response, maxBytes = 4_000_000): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new GatewayError('provider-response-too-large', 'Provider response exceeds limit');
  }
  if (!response.body) return '';
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let count = 0;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; count += part.value.length;
      if (count > maxBytes) { await reader.cancel(); throw new GatewayError('provider-response-too-large', 'Provider response exceeds limit'); } chunks.push(part.value); }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}
export class CoreRpc implements Rpc {
  private sequence = 0;
  constructor(private readonly config: GatewayConfig) {}
  async call<T = unknown>(method: string, params: unknown[] = [], wallet?: string): Promise<T> {
    if (!READ_METHODS.has(method) && method !== 'sendrawtransaction' && !(this.config.network === 'regtest' && WATCH_METHODS.has(method))) throw new GatewayError('rpc-method-denied', 'RPC method is not permitted');
    if (wallet && (this.config.network !== 'regtest' || wallet !== (this.config.watchWallet || 'wallet-web-watch'))) throw new GatewayError('rpc-wallet-denied', 'RPC wallet is not permitted');
    if (WATCH_METHODS.has(method)) {
      const target = new URL(this.config.rpcUrl);
      if (this.config.network !== 'regtest' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || target.port !== '19453') throw new GatewayError('rpc-wallet-denied', 'Watch-only operations require isolated regtest');
      if (method === 'createwallet' && this.config.allowWatchWalletCreation !== true) throw new GatewayError('rpc-wallet-denied', 'Watch-only wallet creation is disabled');
    }
    let credentials: string;
    if (this.config.cookieFile) {
      try { const info = await stat(this.config.cookieFile);
        // Direct cookies stay owner-private; the narrowly pinned systemd ACL
        // exception permits its 0440 credential copy, never a normal group file.
        if (!info.isFile() || ((info.mode & 0o077) !== 0 && !await isPrivateSystemdCredential(this.config.cookieFile, info))) throw new Error('permissions');
        credentials = (await readFile(this.config.cookieFile, 'utf8')).trim();
      } catch { throw new GatewayError('rpc-auth-unavailable', 'Core authentication is unavailable'); }
    } else if (this.config.rpcUsername && this.config.rpcPassword) credentials = `${this.config.rpcUsername}:${this.config.rpcPassword}`;
    else throw new GatewayError('rpc-auth-unavailable', 'Core authentication is unavailable');
    if (!/^[^:\r\n]+:[^\r\n]+$/.test(credentials)) throw new GatewayError('rpc-auth-unavailable', 'Core authentication is invalid');
    const id = ++this.sequence;
    const url = new URL(this.config.rpcUrl);
    if (wallet) url.pathname = `${url.pathname.replace(/\/$/, '')}/wallet/${encodeURIComponent(wallet)}`;
    let response: Response;
    try { response = await (this.config.fetch || fetch)(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(credentials).toString('base64')}` }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal: AbortSignal.timeout(this.config.requestTimeoutMs || 10000), redirect: 'error' }); }
    catch { throw new GatewayError('rpc-unavailable', 'Core RPC is unavailable'); }
    const raw = await readBounded(response); let body: { id?: unknown; result?: T; error?: { code?: unknown; message?: unknown } };
    try { body = JSON.parse(raw); } catch { throw new GatewayError('rpc-invalid-response', 'Core RPC returned an invalid response'); }
    if (!body || body.id !== id) throw new GatewayError('rpc-invalid-response', 'Core RPC response identity mismatch');
    if (body.error) throw new RpcError(typeof body.error.code === 'number' ? body.error.code : -1, typeof body.error.message === 'string' ? body.error.message : 'RPC failed');
    if (!response.ok || !Object.hasOwn(body, 'result')) throw new GatewayError('rpc-unavailable', 'Core RPC is unavailable');
    return body.result as T;
  }
}
