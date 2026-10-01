export type WalletNetwork = 'mainnet' | 'regtest';
export interface WalletMetadata {
  version: 1; id: string; network: WalletNetwork; createdAt: string;
  accountPath: string; accountXpub: string; fingerprint: string; backupConfirmed: boolean;
}
export interface AddressRecord {
  address: string; scriptHex: string; branch: 0 | 1; index: number; path: string;
}
export type NetworkReadinessReason = 'block-validation' | 'node-sync' | 'index-sync' | 'index-unavailable' | 'stale-data';
export interface NetworkInfo {
  network: WalletNetwork; chain: string; genesisHash: string; height: number;
  tipHash: string; indexedHeight: number; ready: boolean; observedAt: string;
  explorerUrl: string | null; minConfirmations: number; coinbaseMaturity: number;
  averageBlockSeconds?: number; blockTimeSampleSize?: number; lastBlockTime?: number;
  readinessReason?: NetworkReadinessReason;
  pendingValidationBlocks?: number;
}
export interface AddressActivity { address: string; used: boolean; }
export interface Utxo {
  txid: string; vout: number; address: string; scriptHex: string; amountUnits: string;
  confirmations: number; blockHeight: number | null; coinbase: boolean;
  classification: 'native' | 'unsupported' | 'unknown'; rawParent: string | null;
  verified: boolean;
}
export interface HistoryEntry {
  txid: string; deltaUnits: string; feeUnits: string | null;
  status: 'pending' | 'confirmed' | 'conflicted'; confirmations: number;
  blockHeight: number | null; timestamp: number | null;
}
export interface WalletSnapshot {
  network: NetworkInfo; addresses: AddressActivity[]; utxos: Utxo[];
  history: HistoryEntry[]; complete: boolean; warnings: string[]; observedAt: string;
  mempoolFingerprint?: string;
  spentOutpoints?: { txid: string; vout: number; spentByTxid: string }[];
}
export interface FeePolicy {
  relayFloorUnitsPerVbyte: string; mempoolFloorUnitsPerVbyte: string;
  suggestedRate: string; observedAt: string;
}
export interface SpendRequest {
  network: WalletNetwork; recipient: string; amountUnits: string;
  feeRate: string; sendMax?: boolean; utxos: Utxo[];
  ownedAddresses: AddressRecord[]; change: AddressRecord;
}
export interface TransferPlan {
  id: string; network: WalletNetwork; recipient: string; amountUnits: string;
  feeUnits: string; feeRate: string; changeAddress: string | null; changeUnits: string;
  inputCount: number; inputs: { txid: string; vout: number; amountUnits: string }[];
  estimatedVsize: number; createdAt: string;
}
export interface SignedTransfer { txid: string; rawHex: string; feeUnits: string; vsize: number; }
export interface ValidationResult { txid: string; allowed: boolean; alreadyKnown?: boolean; reason?: string; canDiscard?: boolean; }
export interface BroadcastResult { txid: string; status: 'accepted' | 'already-known'; }

export interface WalletEngine {
  getMetadata(): Promise<WalletMetadata | null>;
  create(password: string, network: WalletNetwork): Promise<{ metadata: WalletMetadata; mnemonic: string }>;
  restore(mnemonic: string, password: string, network: WalletNetwork): Promise<WalletMetadata>;
  unlock(password: string): Promise<WalletMetadata>;
  lock(): Promise<void>;
  recordActivity(): Promise<void>;
  acknowledgeBackup(): Promise<WalletMetadata>;
  getAddresses(branch: 0 | 1, start: number, count: number): Promise<AddressRecord[]>;
  prepareTransfer(request: SpendRequest): Promise<TransferPlan>;
  signTransfer(planId: string): Promise<SignedTransfer>;
  exportBackup(password: string): Promise<string>;
  importBackup(encryptedJson: string, password: string): Promise<WalletMetadata>;
  revealMnemonic(password: string): Promise<string>;
  changePassword(currentPassword: string, newPassword: string): Promise<void>;
  reset(password: string): Promise<void>;
}
