import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { resolveConfig, type GatewayConfig } from './config';
import { CoreRpc } from './rpc';
import { Gateway } from './gateway';
import { GatewayError } from './errors';
import { publicMetadata, snapshotSources, verifyManifest, type BuildMetadata } from './build';

const rawBody = z.object({ rawHex: z.string().min(20).max(400_000).regex(/^(?:[0-9a-fA-F]{2})+$/).transform(v => v.toLowerCase()) }).strict();
const syncBody = z.object({ addresses: z.array(z.string().min(14).max(100).regex(/^[a-z0-9]+$/)).min(1).max(100) }).strict().refine(v => new Set(v.addresses).size === v.addresses.length);
const txParams = z.object({ txid: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const rawQuery = z.object({ blockHash: z.string().regex(/^[0-9a-f]{64}$/).optional() }).strict();
export async function buildApp(input: GatewayConfig): Promise<FastifyInstance> {
  const config = resolveConfig(input);
  const sourceRoot = await realpath(fileURLToPath(new URL('../', import.meta.url)));
  const staticRoot = config.staticDir ? await realpath(resolve(config.staticDir)) : undefined;
  const requireRelease = process.env.NODE_ENV === 'production' || (config.requireRelease ?? false);
  let build: Readonly<BuildMetadata>;
  if (staticRoot) {
    try { build = publicMetadata(await verifyManifest(staticRoot, sourceRoot, requireRelease)); }
    catch (error) {
      if (requireRelease || !error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
      const source = await snapshotSources(sourceRoot);
      build = publicMetadata({ schemaVersion: 1, version: source.version, commit: null, dirty: true, release: false, builtAt: new Date().toISOString(), sourceSha256: source.sourceSha256 });
    }
  } else {
    if (requireRelease) throw new Error('Production requires a static release and build manifest');
    const source = await snapshotSources(sourceRoot);
    build = publicMetadata({ schemaVersion: 1, version: source.version, commit: null, dirty: true, release: false, builtAt: new Date().toISOString(), sourceSha256: source.sourceSha256 });
  }
  const app = Fastify({ logger: config.logger ? { redact: ['req.headers.authorization', 'req.headers.cookie', 'req.body', 'res.headers.set-cookie'] } : false, disableRequestLogging: true, trustProxy: ['127.0.0.1', '::1'], bodyLimit: 1_000_000, ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
  const gateway = new Gateway(config, config.rpc || new CoreRpc(config));
  const allowedOrigins = new Set(config.allowedOrigins);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('X-Frame-Options', 'DENY').header('Referrer-Policy', 'no-referrer').header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; worker-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (request.url.startsWith('/api/') || request.url === '/health') reply.header('Cache-Control', 'no-store');
    const origin = request.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) throw new GatewayError('origin-denied', 'Request origin is not allowed', 403);
    if (origin) reply.header('Access-Control-Allow-Origin', origin).header('Vary', 'Origin');
    if (request.method === 'POST') {
      if (request.headers['sec-fetch-site'] === 'cross-site') throw new GatewayError('origin-denied', 'Cross-site mutation is not allowed', 403);
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) throw new GatewayError('json-required', 'JSON content type is required', 415);
    }
  });
  app.addHook('onSend', async (_request, reply, payload) => {
    const contentType = reply.getHeader('Content-Type');
    if (typeof contentType === 'string' && /^text\/html(?:;|$)/i.test(contentType)) reply.header('Cache-Control', 'no-store');
    return payload;
  });
  await app.register(rateLimit, { max: config.rateLimit ?? 90, timeWindow: '1 minute', skipOnError: false });
  app.options('/api/v1/*', async (request, reply) => {
    if (!request.headers.origin || !allowedOrigins.has(request.headers.origin)) throw new GatewayError('origin-denied', 'Request origin is not allowed', 403);
    if (request.headers['access-control-request-method'] && !['GET', 'POST'].includes(request.headers['access-control-request-method'])) throw new GatewayError('method-denied', 'Request method is not allowed', 403);
    const headers = (request.headers['access-control-request-headers'] || '').toLowerCase().split(',').map(v => v.trim()).filter(Boolean);
    if (headers.some(v => v !== 'content-type')) throw new GatewayError('header-denied', 'Request headers are not allowed', 403);
    return reply.header('Access-Control-Allow-Methods', 'GET, POST').header('Access-Control-Allow-Headers', 'Content-Type').header('Access-Control-Max-Age', '600').code(204).send();
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof GatewayError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    const status = error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 503;
    if (status === 429) return reply.code(429).send({ error: { code: 'rate-limited', message: 'Too many requests; retry later' } });
    if (status >= 400 && status < 500) return reply.code(status).send({ error: { code: 'invalid-request', message: 'Invalid request' } });
    return reply.code(503).send({ error: { code: 'provider-unavailable', message: 'Chain provider is unavailable' } });
  });
  const parse = <T>(schema: z.ZodType<T>, value: unknown): T => { const result = schema.safeParse(value); if (!result.success) throw new GatewayError('invalid-request', 'Invalid request', 400); return result.data; };
  app.get('/api/build', async (_request, reply) => reply.header('Cache-Control', 'no-store').send(build));
  app.get('/api/v1/network', async () => gateway.network());
  app.post('/api/v1/wallet/sync', { bodyLimit: 16_384, config: { rateLimit: { max: config.syncRateLimit ?? 60, timeWindow: '1 minute' } } }, async request => gateway.sync(parse(syncBody, request.body).addresses));
  app.get('/api/v1/tx/:txid/raw', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async request => {
    const { txid } = parse(txParams, request.params); const { blockHash } = parse(rawQuery, request.query);
    const network = await gateway.network(); if (!network.ready) throw new GatewayError('network-not-ready', 'Chain data is not synchronized or fresh');
    return { txid, rawHex: await gateway.raw(txid, blockHash) };
  });
  app.get('/api/v1/fees', async () => gateway.fees());
  app.post('/api/v1/tx/validate', { bodyLimit: 420_000, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async request => gateway.validate(parse(rawBody, request.body).rawHex));
  app.post('/api/v1/tx/broadcast', { bodyLimit: 420_000, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async request => gateway.broadcast(parse(rawBody, request.body).rawHex));
  app.get('/health', async (_request, reply) => {
    const network = await gateway.network(); return reply.code(network.ready ? 200 : 503).send({ ok: network.ready, network: network.network, height: network.height, observedAt: network.observedAt });
  });
  if (staticRoot) {
    const root = staticRoot; const info = await stat(root); if (!info.isDirectory()) throw new Error('Static build directory is invalid');
    await app.register(fastifyStatic, { root, wildcard: false, index: ['index.html'], dotfiles: 'deny', cacheControl: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/') && !request.url.startsWith('/assets/') && request.headers.accept?.includes('text/html')) return reply.header('Cache-Control', 'no-store').sendFile('index.html');
      return reply.code(404).send({ error: { code: 'not-found', message: 'Not found' } });
    });
  } else app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: { code: 'not-found', message: 'Not found' } }));
  return app;
}
export type { GatewayConfig } from './config';
