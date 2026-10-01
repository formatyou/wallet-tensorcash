import type { WalletNetwork, NetworkInfo } from '../shared/types';
import type { BTC_NETWORK } from '@scure/btc-signer/utils.js';

export const ACCOUNT_PATH = "m/84'/1'/0'";
export const NETWORKS: Record<WalletNetwork, { bitcoin: BTC_NETWORK; bip32: { public: number; private: number }; chain: string; genesisHash: string }> = {
  mainnet: { bitcoin: { bech32: 'tc', pubKeyHash: 0x42, scriptHash: 0x13, wif: 0xd2 }, bip32: { public: 0x04544350, private: 0x04544358 }, chain: 'tensor', genesisHash: '8fe43be4634dc48def074fa840e25a71bbdc32576eb29abf3ce2458605343720' },
  regtest: { bitcoin: { bech32: 'bcrt', pubKeyHash: 111, scriptHash: 196, wif: 239 }, bip32: { public: 0x043587cf, private: 0x04358394 }, chain: 'regtest', genesisHash: 'cf63c021e5a8ea0bc04cf7b12ab12e0a7902ef2dae5bdd8cbb3a0d41c3345da4' },
};
export function networkConfig(network: WalletNetwork) {
  if (network !== 'mainnet' && network !== 'regtest') throw new Error('Unsupported wallet network');
  return NETWORKS[network];
}
export function assertNetwork(info: NetworkInfo, expected: WalletNetwork): void {
  const config = networkConfig(expected);
  if (info.network !== expected || info.chain !== config.chain || info.genesisHash !== config.genesisHash || !info.ready || info.indexedHeight !== info.height) throw new Error('Network identity or synchronization does not match');
  if (!Number.isSafeInteger(info.height) || info.height < 0 || !/^[a-f0-9]{64}$/.test(info.tipHash)) throw new Error('Invalid chain checkpoint');
  const age = Date.now() - Date.parse(info.observedAt);
  if (!Number.isFinite(age) || age < -30_000 || age > 120_000) throw new Error('Chain checkpoint is stale');
}
