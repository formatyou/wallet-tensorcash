import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { publicMetadata, validateManifest } from '../server/build.ts';

const root = resolve(process.argv[2] || resolve(import.meta.dirname, '..'));
const expected = publicMetadata(validateManifest(JSON.parse(await readFile(resolve(root, 'dist/build.json'), 'utf8')), true));
const configuredOrigin = process.env.WALLET_ACTIVATION_ORIGIN || 'http://127.0.0.1:8790';
const origin = new URL(configuredOrigin);
if (origin.origin !== configuredOrigin || !['http:', 'https:'].includes(origin.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || origin.username || origin.password)
  throw new Error('WALLET_ACTIVATION_ORIGIN must be an exact loopback HTTP(S) origin.');

// Readiness of build provenance is independent of Core and its chain/index state.
const deadline = Date.now() + 25000;
let reason = 'No build metadata response';
while (Date.now() < deadline) {
  try {
    const response = await fetch(new URL('/api/build', origin), { cache: 'no-store', signal: AbortSignal.timeout(2000) });
    if (response.status !== 200 || response.headers.get('cache-control') !== 'no-store')
      throw new Error('Build endpoint status or no-store header differs');
    const actual = await response.json();
    if (!actual || Object.keys(actual).sort().join(',') !== Object.keys(expected).sort().join(',') ||
        Object.entries(expected).some(([key, value]) => actual[key] !== value))
      throw new Error('Active gateway metadata differs from the assembled release');
    process.stdout.write(`Active gateway matches release ${expected.commit}\n`);
    process.exit(0);
  } catch (error) { reason = error.message; }
  await new Promise(resolveWait => setTimeout(resolveWait, 1000));
}
throw new Error(`Release activation check failed: ${reason}`);
