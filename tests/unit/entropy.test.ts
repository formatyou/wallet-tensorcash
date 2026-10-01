import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, pbkdf2Sync } from 'node:crypto';
import { HDKey } from '@scure/bip32';
import { entropyToMnemonic, mnemonicToEntropy, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { hex } from '@scure/base';
import { deriveAccount, newMnemonic } from '../../src/core/keys';
import { ACCOUNT_PATH, NETWORKS } from '../../src/core/network';
import { LocalWalletEngine } from '../../src/wallet/engine';
import type { VaultStorage } from '../../src/wallet/storage';
import fixtures from '../fixtures/bip39-english.json';

// Public official fixtures only. TREZOR belongs to the vectors; the app uses
// an empty BIP39 passphrase. Tests never log newly generated wallet phrases.
const engines: LocalWalletEngine[] = [];
afterEach(async () => {
  try { await Promise.all(engines.map(engine => engine.lock())); }
  finally { engines.length = 0; vi.restoreAllMocks(); vi.unstubAllGlobals(); }
});

function emptyStorage() {
  let value: string | null = null;
  const storage = {
    read: vi.fn(async () => value),
    write: vi.fn(async (replacement: string) => { value = replacement; }),
    clear: vi.fn(async () => { value = null; }),
    compareAndSwap: vi.fn(async (expected: string | null, replacement: string | null) => {
      if (value !== expected) throw new Error('Wallet changed in another tab');
      value = replacement;
    }),
  } satisfies VaultStorage;
  return storage;
}

describe('wallet entropy and canonical derivation boundaries', () => {
  it('requests exactly 16 bytes from getRandomValues and encodes them unchanged', () => {
    const fixture = fixtures.vectors[4];
    const entropy = hex.decode(fixture.entropy);
    const getRandomValues = vi.fn((array: Uint8Array) => {
      expect(array).toBeInstanceOf(Uint8Array);
      expect(array.byteLength).toBe(16);
      array.set(entropy);
      return array;
    });
    vi.stubGlobal('crypto', { getRandomValues });
    const mnemonic = newMnemonic();
    expect(getRandomValues).toHaveBeenCalledTimes(1);
    expect(mnemonic).toBe(fixture.mnemonic);
    expect(mnemonic.split(' ')).toHaveLength(12);
    expect(mnemonicToEntropy(mnemonic, wordlist)).toEqual(entropy);
  });

  it('uses all 2048 distinct canonical English words in their official order', () => {
    expect(wordlist).toHaveLength(2048);
    expect(new Set(wordlist).size).toBe(2048);
    // bitcoin/bips english.txt is UTF-8, one word per line, with a final LF.
    // Pin the independently fetched upstream file, not a hash made from scure.
    const canonicalFile = `${wordlist.join('\n')}\n`;
    expect(createHash('sha256').update(canonicalFile, 'utf8').digest('hex'))
      .toBe(fixtures.wordlistFileSha256);
    // Every 11-bit first-word index remains reachable; no word subset/filter.
    const entropy = new Uint8Array(16);
    vi.stubGlobal('crypto', { getRandomValues: (array: Uint8Array) => { array.set(entropy); return array; } });
    for (let index = 0; index < 2048; index++) {
      entropy[0] = index >>> 3;
      entropy[1] = (index & 7) << 5;
      expect(newMnemonic().split(' ')[0]).toBe(wordlist[index]);
    }
  });

  it.each(fixtures.vectors.map((vector, index) => [index, vector] as const))(
    'matches official BIP39 and BIP32 master vector %i', (_index, vector) => {
      const entropy = hex.decode(vector.entropy);
      expect(entropy).toHaveLength(16);
      expect(entropyToMnemonic(entropy, wordlist)).toBe(vector.mnemonic);
      expect(validateMnemonic(vector.mnemonic, wordlist)).toBe(true);
      expect(mnemonicToEntropy(vector.mnemonic, wordlist)).toEqual(entropy);
      const seed = mnemonicToSeedSync(vector.mnemonic, fixtures.vectorPassphrase);
      let root: HDKey | undefined;
      try {
        expect(seed).toHaveLength(64);
        expect(hex.encode(seed)).toBe(vector.seed);
        root = HDKey.fromMasterSeed(seed);
        expect(root.privateExtendedKey).toBe(vector.masterXprv);
      } finally { seed.fill(0); root?.wipePrivateData(); }
    },
  );

  it('passes the entire independent 64-byte empty-passphrase seed to BIP32', () => {
    const fixture = fixtures.vectors[4];
    const expectedSeed = pbkdf2Sync(fixture.mnemonic.normalize('NFKD'), 'mnemonic', 2048, 64, 'sha512');
    const original = HDKey.fromMasterSeed;
    let suppliedSeed: Uint8Array | undefined;
    let originalSeed: Uint8Array | undefined;
    const fromMasterSeed = vi.spyOn(HDKey, 'fromMasterSeed').mockImplementation((seed, versions) => {
      originalSeed = seed;
      suppliedSeed = Uint8Array.from(seed); // app deliberately zeroes its own buffer
      return original.call(HDKey, seed, versions);
    });
    let account: HDKey | undefined;
    let expectedRoot: HDKey | undefined;
    let expectedAccount: HDKey | undefined;
    try {
      account = deriveAccount(fixture.mnemonic, 'regtest');
      expect(fromMasterSeed).toHaveBeenCalledTimes(1);
      expect(suppliedSeed).toHaveLength(64);
      expect(suppliedSeed).toEqual(Uint8Array.from(expectedSeed));
      expect(hex.encode(suppliedSeed!)).not.toBe(fixture.seed); // fixture uses TREZOR
      expect(originalSeed?.every(byte => byte === 0)).toBe(true);
      expectedRoot = original.call(HDKey, expectedSeed, NETWORKS.regtest.bip32);
      expectedAccount = expectedRoot.derive(ACCOUNT_PATH);
      expect(account.publicExtendedKey).toBe(expectedAccount.publicExtendedKey);
      expect(account.chainCode).toEqual(expectedAccount.chainCode);
    } finally {
      expectedSeed.fill(0); suppliedSeed?.fill(0);
      account?.wipePrivateData(); expectedAccount?.wipePrivateData(); expectedRoot?.wipePrivateData();
    }
  });

  it('preserves each of the 128 entropy bits through mnemonic round-trip', () => {
    // Deterministic public inputs check reversible encoding, not RNG quality.
    const phrases = new Set<string>();
    for (let bit = 0; bit < 128; bit++) {
      const entropy = new Uint8Array(16);
      entropy[bit >>> 3] = 1 << (7 - (bit & 7));
      const mnemonic = entropyToMnemonic(entropy, wordlist);
      expect(mnemonicToEntropy(mnemonic, wordlist)).toEqual(entropy);
      phrases.add(mnemonic);
    }
    expect(phrases.size).toBe(128);
  });

  it.each(['missing', 'throwing'] as const)('fails closed without storage or session when CSPRNG is %s', async scenario => {
    const storage = emptyStorage();
    const engine = new LocalWalletEngine(storage);
    engines.push(engine);
    const getRandomValues = vi.fn((_array: Uint8Array) => { throw new Error('simulated CSPRNG failure'); });
    const randomUUID = vi.fn(() => { throw new Error('unexpected metadata generation'); });
    const weakRandom = vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('weak random fallback is forbidden'); });
    vi.stubGlobal('crypto', scenario === 'missing' ? { randomUUID } : { getRandomValues, randomUUID });
    expect(() => newMnemonic()).toThrow(scenario === 'missing' ? /getRandomValues must be defined/ : /simulated CSPRNG failure/);
    await expect(engine.create('public test password phrase', 'regtest'))
      .rejects.toThrow(scenario === 'missing' ? /getRandomValues must be defined/ : /simulated CSPRNG failure/);
    expect(await engine.getMetadata()).toBeNull();
    await expect(engine.signTransfer('no-session')).rejects.toThrow(/Unlock/);
    expect(storage.write).not.toHaveBeenCalled();
    expect(storage.compareAndSwap).not.toHaveBeenCalled();
    expect(storage.clear).not.toHaveBeenCalled();
    expect(randomUUID).not.toHaveBeenCalled();
    expect(weakRandom).not.toHaveBeenCalled();
    if (scenario === 'throwing') {
      expect(getRandomValues).toHaveBeenCalledTimes(2);
      for (const [requested] of getRandomValues.mock.calls) expect(requested.byteLength).toBe(16);
    }
  });
});
