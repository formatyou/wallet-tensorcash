import { readFile, readdir, stat, writeFile, copyFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

// Include the browser dependency closure. The deployed server additionally
// retains each installed package's own notices inside node_modules.
const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
async function locate(name, from) {
  let directory = from;
  while (true) {
    const candidate = join(directory, 'node_modules', name);
    try { if ((await stat(join(candidate, 'package.json'))).isFile()) return candidate; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Missing runtime dependency: ${name}`);
    directory = parent;
  }
}
const browserDependencies = ['@noble/hashes', '@scure/base', '@scure/bip32', '@scure/bip39', '@scure/btc-signer', 'qrcode', 'react', 'react-dom', 'zod'];
for (const name of browserDependencies) if (!manifest.dependencies[name]) throw new Error(`Missing browser dependency declaration: ${name}`);
const queue = browserDependencies.map(name => ({ name, from: root }));
const packages = new Map();
while (queue.length) {
  const next = queue.shift();
  const path = await locate(next.name, next.from);
  if (packages.has(path)) continue;
  const data = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
  const files = (await readdir(path)).filter(name => /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(name));
  const notices = [];
  for (const file of files.sort()) if ((await stat(join(path, file))).isFile()) notices.push(await readFile(join(path, file), 'utf8'));
  if (!notices.length) throw new Error(`Runtime dependency has no distributable license file: ${data.name}@${data.version}`);
  packages.set(path, { name: data.name, version: data.version, license: data.license, notices });
  for (const name of Object.keys(data.dependencies || {})) queue.push({ name, from: path });
  for (const name of Object.keys(data.optionalDependencies || {})) {
    try { await locate(name, path); queue.push({ name, from: path }); }
    catch (error) { if (!error.message.startsWith('Missing runtime dependency:')) throw error; }
  }
}
const body = ['# Third-party notices', '', 'Browser dependency licenses shipped with TensorCash Wallet.', ''];
for (const item of [...packages.values()].sort((a, b) => a.name.localeCompare(b.name))) {
  body.push(`## ${item.name}@${item.version} (${String(item.license)})`, '', ...item.notices.flatMap(notice => [notice.trim(), '']));
}
await writeFile(join(root, 'dist', 'THIRD_PARTY_NOTICES.txt'), body.join('\n') + '\n');
await copyFile(join(root, 'LICENSE'), join(root, 'dist', 'LICENSE.txt'));
process.stdout.write(`Preserved license notices for ${packages.size} browser dependency packages.\n`);
