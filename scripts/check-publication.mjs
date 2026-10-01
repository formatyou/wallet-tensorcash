#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const english = new Set(wordlist);
// Reviewed public Trezor vectors. Changes to the fixture require a new audit.
const vectorFile = 'tests/fixtures/bip39-english.json';
const vectorFileSha256 = '050a67b596fe6594f51e4ba7a75c8941cabbd8a74b561c5b71eec2cf5c4a209d';
const publicMnemonicHashes = new Set([
  'c557eec878dfd852ba3f88087c4f350f09c55537ab5e549c3cd14320ec3cef38',
  'ecb0e7ba498c5920991f0b3483e91f7abafa9ecc6bd82a9a51494589592b1a8f',
  '3a64bcd9cea43c0aba67ba0bf2ddff8137a492bccbc672107fcbf7381086f698',
  '3c0949435a7e4277fac2fbe27975cdd9f5b5abf94d282112eaf4cebbb8560984',
  'd6da54d12db9eac818868b841c1c9cc7c39f5294c8620ad24b7715b7820febc0',
]);
const vectorTestPaths = new Set([
  'src/ui/broadcast-journal.test.ts', 'tests/e2e/display-cache.spec.ts',
  'tests/e2e/recovery.spec.ts', 'tests/e2e/toast.spec.ts', 'tests/e2e/ui.spec.ts',
  'tests/unit/coin-selection.test.ts', 'tests/unit/core.test.ts',
  'tests/unit/display-cache.test.ts', 'tests/unit/reconciliation.test.ts',
  'tests/unit/vault.test.ts',
]);
// Only these exact reviewed lines contain isolated test credentials.
const mockCredentialLines = new Map(Object.entries({
  'tests/e2e/coin-selection-regtest.spec.ts': ['af23e5f8785af98f02ae474cad71743526d87937661bfe3d326d29c6eb184eee'],
  'tests/e2e/toast.spec.ts': ['4621f338459e8bb7a0f13e16ce2bd40ca399fddb72dfbd777e1646ebff141222'],
  'tests/e2e/regtest.spec.ts': ['8755bc73910a8ce5f77ec9ae60e435457054c166c6f8e073f59be1c287d9341c'],
  'tests/e2e/ui.spec.ts': ['a335b00649f0f59710d02b28b109dada1c350e0f82daabd7f65ea410725c18cd'],
  'tests/e2e/utxos.spec.ts': ['29fb85dece57fe79230b0e51fa0b3c0ddc161694789eed1efd3073d82928f201'],
  'tests/e2e/display-cache.spec.ts': ['2e79f21641283aa7885109e9966c1b5cf6dd9b465d8bf4c6a17f1d212776d2ed'],
  'tests/e2e/recovery.spec.ts': ['0f47955f3fa0738586bd302d3a26facc57bc2d3619348fc56543f950701af5ab'],
  'tests/unit/display-cache.test.ts': [
    '2e79f21641283aa7885109e9966c1b5cf6dd9b465d8bf4c6a17f1d212776d2ed',
    '9f23cd861f97d88350c8a73641fc0cf65f9e4d664f9e275dfd35ec0a797b647b',
  ],
  'tests/unit/vault.test.ts': ['a0057d22be2ea737b44e7ae87bfdc156c27711f477f43c17f76dc6cb3922f742'],
  'server/rpc.test.ts': [
    'ec6c742ee86c293f52b16d0636ec974f3ae6af220b71c5c593c90367979f8bbd',
    'e2dc1a90402ad09f4c6bb57aae134a2e2fafc87e768cca8cdca305a98a84f99b',
    '8995e91e8de25ad75a36da0ca0047a6eb89640d17706d994ffb859d38ea102b5',
  ],
  'server/app.test.ts': [
    'a3568d107857fd5c7709826225d6b7d654ddb77ac4620362b3249b8356e2aeb5',
    '4f68852fc2f6fe2b46af343835a21eb614813cc98e923f0e836c81eae0f82ef0',
  ],
}));
// Reserved documentation addresses used to exercise rate limiting; path and line pinned.
const mockNetworkLines = new Map(Object.entries({
  'server/app.test.ts': [
    'c335d859ee36110e47c5f1aa04f853c18578e347a641d084e4b2e90ccbbb81eb',
    '8324aa7dc212c58f33e66a9365fc96b92c08a8095119be2374766ebe2efbf04c',
    '6f16f5b0ee2df6caf3c7e504a7a6fbaf83896278b65b1908e86b83a30678ffee',
  ],
}));

const excludedDirectories = new Set([
  'node_modules', 'dist', 'artifacts', 'test-results', 'playwright-report',
  'coverage', '.runtime', 'runtime', '.aws', '.ssh', '.gnupg',
  'wallets', 'backups', 'backup', 'logs', 'evidence', '.git',
]);
const publicImages = new Set([
  'public/favicon-32x32-v2.png', 'public/apple-touch-icon.png',
  'public/favicon.ico', 'public/favicon-32x32.png',
]);

function pathCategory(path) {
  const parts = path.split('/');
  const name = parts.at(-1);
  if (parts.some(part => excludedDirectories.has(part.toLowerCase()))) return 'excluded-runtime-or-evidence';
  if (/^\.env(?:\.|$)/i.test(name) && path !== '.env.example') return 'environment-values';
  if (/^(?:\.cookie|(?:credentials|secrets|service-account)(?:\..*)?|id_(?:rsa|ed25519|ecdsa|dsa)(?:\.pub)?|wallet(?:\.dat)?|tensorcash\.conf|bitcoin\.conf)$/i.test(name)) return 'credentials-or-wallet';
  if (/^(?:wallet|vault|seed|mnemonic|private[_-]?key)(?:[-_.].*)?\.(?:json|txt|dat)$/i.test(name)) return 'credentials-or-wallet';
  if (/\.(?:pem|key|p12|pfx|dat|sqlite(?:3)?|db|log|bak|backup|old|tar(?:\.(?:gz|bz2|xz|zst))?|tgz|zip|7z|rar|gz|xz|bz2|zst)$/i.test(name)) return 'data-log-backup-or-archive';
  if (/[\x00-\x1f\x7f]/.test(path)) return 'unsafe-path';
  return null;
}

function contentCategories(path, buffer) {
  const categories = new Set();
  const reviewedVectors = path === vectorFile && sha256(buffer) === vectorFileSha256;
  if (path === vectorFile && !reviewedVectors) categories.add('changed-public-vector-fixture');
  const text = buffer.toString('utf8');
  if (buffer.includes(0) && !publicImages.has(path)) categories.add('unreviewed-binary');
  if (buffer.length > 2 * 1024 * 1024) categories.add('oversized-file');
  const patterns = [
    ['private-key-block', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/],
    ['service-token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{15,}|sk_(?:live|test)_[A-Za-z0-9]{16,})\b/],
    ['credential-url', /(?:https?|wss?):\/\/[^\s/:]+:[^\s/@]+@/],
    ['operator-home-path', /\/(?:root|Users)\/|\/home\/(?!user(?:\/|\b))[^\s/]+\//],
    ['extended-private-key', /\b(?:xprv|tprv|yprv|zprv)[1-9A-HJ-NP-Za-km-z]{30,}\b/],
    ['wallet-private-key', /\b(?:5[HJK][1-9A-HJ-NP-Za-km-z]{49}|[KLc][1-9A-HJ-NP-Za-km-z]{51}|9[1-9A-HJ-NP-Za-km-z]{50})\b/],
  ];
  for (const [category, regex] of patterns) {
    if (category === 'extended-private-key' && reviewedVectors) continue;
    if (regex.test(text)) categories.add(category);
  }
  for (const line of text.split('\n')) {
    const reviewedMock = mockCredentialLines.get(path)?.includes(sha256(line.trim()));
    if (!mockNetworkLines.get(path)?.includes(sha256(line.trim()))) {
      for (const match of line.matchAll(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g)) {
        const octets = match.slice(1).map(Number);
        if (octets.every(n => n <= 255) && octets[0] !== 127 && match[0] !== '0.0.0.0') categories.add('operator-network-address');
      }
    }
    const credential = /(?<![\w-])\b(?:rpc_?(?:user(?:name)?|password)|api[_-]?key|access[_-]?token|authorization|secret(?:[_-]?key)?|password|passphrase|private[_-]?key|mnemonic|seed)\s*["']?\s*[:=]\s*["']([^"'\r\n]+)["']/ig;
    for (const match of line.matchAll(credential)) {
      const value = match[1];
      if (reviewedMock || reviewedVectors) continue;
      if (path === '.env.example' && /^(?:<[^>]+>|\$\{[A-Z_][A-Z0-9_]*\})$/.test(value)) continue;
      if (/^(?:string|utf8|hex|base64|true|false)$/.test(value)) continue;
      if (/^\b(?:mnemonic|seed)\b/i.test(match[0]) && vectorTestPaths.has(path) && publicMnemonicHashes.has(sha256(value))) continue;
      categories.add('credential-literal');
    }
    if (/writeFile\(cookie,\s*["'][^"'\r\n]+:[^"'\r\n]+["']/.test(line) && !reviewedMock) categories.add('cookie-credential-literal');
    const envAssignment = /^\s*(?:export\s+)?(?:CORE_RPC_(?:USER|PASSWORD)|rpc_?(?:user(?:name)?|password)|SEED|MNEMONIC|[A-Z][A-Z0-9_]*(?:SECRET|PASSWORD|TOKEN|API_KEY))\s*=\s*(.+?)\s*$/i.exec(line);
    if (envAssignment && !/^(["']?)(?:<[^>]+>|\$\{[A-Z_][A-Z0-9_]*\})\1$/.test(envAssignment[1]) && envAssignment[1] !== "''" && envAssignment[1] !== '""') categories.add('credential-environment-value');
  }
  // Scan word runs, including phrases outside quotes; only valid checksums count.
  for (const run of text.matchAll(/\b[a-z]+(?:[ \t]+[a-z]+){11,}\b/g)) {
    const tokens = run[0].split(/[ \t]+/);
    for (let start = 0; start < tokens.length; start++) {
      for (const length of [12, 15, 18, 21, 24]) {
        const words = tokens.slice(start, start + length);
        if (words.length !== length || !words.every(word => english.has(word))) continue;
        const phrase = words.join(' ');
        if (!validateMnemonic(phrase, wordlist)) continue;
        if (reviewedVectors || (vectorTestPaths.has(path) && publicMnemonicHashes.has(sha256(phrase)))) continue;
        categories.add('unreviewed-wallet-mnemonic');
      }
    }
  }
  // A literal BIP39 seed is 512 bits; ordinary commit, transaction and SHA256 hashes are 256 bits.
  if (!reviewedVectors && /\b[0-9a-fA-F]{128}\b/.test(text)) categories.add('unreviewed-seed-or-long-secret');
  return [...categories];
}

export function auditPublication({ cwd = process.cwd(), head = false } = {}) {
  // Alternate indexes/object stores and replacement refs must not redirect this audit.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  const git = args => execFileSync('git', ['--no-replace-objects', ...args], { cwd, env, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const snapshot = head ? git(['rev-parse', '--verify', 'HEAD']).toString().trim() : git(['ls-files', '--stage', '-z']);
  const listing = head ? git(['ls-tree', '-r', '-z', snapshot]) : snapshot;
  const entries = listing.toString('utf8').split('\0').filter(Boolean).map(record => {
    const split = record.indexOf('\t');
    const info = record.slice(0, split).split(' ');
    return head ? { mode: info[0], oid: info[2], stage: '0', path: record.slice(split + 1) }
      : { mode: info[0], oid: info[1], stage: info[2], path: record.slice(split + 1) };
  });
  const findings = [];
  const add = (path, category) => findings.push({ path, category });
  if (entries.length === 0) add('<snapshot>', 'empty-snapshot');
  for (const entry of entries) {
    const excluded = pathCategory(entry.path);
    if (excluded) add(entry.path, excluded);
    if (entry.stage !== '0') { add(entry.path, 'unmerged-index'); continue; }
    if (!['100644', '100755'].includes(entry.mode)) { add(entry.path, 'symlink-or-submodule'); continue; }
    const buffer = git(['cat-file', 'blob', entry.oid]);
    for (const category of contentCategories(entry.path, buffer)) add(entry.path, category);
  }
  if (!head && !git(['ls-files', '--stage', '-z']).equals(snapshot)) add('<snapshot>', 'index-changed-during-audit');
  const unique = [...new Map(findings.map(f => [`${f.path}\0${f.category}`, f])).values()]
    .sort((a, b) => a.path.localeCompare(b.path) || a.category.localeCompare(b.category));
  return { schemaVersion: 1, snapshot: head ? 'HEAD' : 'index', commit: head ? snapshot : null, files: entries.length, ok: unique.length === 0, findings: unique };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.slice(2).some(arg => arg !== '--head')) throw new Error('usage');
    const result = auditPublication({ head: process.argv.includes('--head') });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.ok ? 0 : 1;
  } catch {
    // Git error messages can contain arbitrary filenames or configuration values.
    process.stderr.write('Publication audit failed: snapshot could not be inspected.\n');
    process.exitCode = 2;
  }
}
