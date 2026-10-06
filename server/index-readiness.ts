import { hash, integer, type RecordData } from './data';

interface AcceptedTip { height: number; hash: string; headers: number; }
const VALIDATION_WAIT_WARNING = 'TensorCash Core is still synchronizing the chain.';
const BLOCK_AGE_WARNING = 'The Core chain tip is older than 30 minutes.';

export function indexSupportsAcceptedTip(index: RecordData, tip: AcceptedTip, now: number): boolean {
  try {
    if (tip.headers < tip.height || index.core_online !== true || index.initial_block_download !== false || integer(index.lag_blocks) !== 0
      || integer(index.indexed_height) !== tip.height || hash(index.indexed_tip) !== tip.hash
      || Math.abs(now - integer(index.checked_at)) > 30) return false;
    if (index.ready === true) return true;
    // A mining pause does not make a fresh accepted-chain/mempool observation
    // stale. The explorer also labels pending, unaccepted headers as syncing.
    // Override only these explicit advisories, never unknown readiness failures.
    if (index.ready !== false || index.state !== 'syncing' || index.effective_work_ready !== true
      || integer(index.core_height) !== tip.height || integer(index.core_headers) !== tip.headers
      || index.verification_progress !== 1) return false;
    integer(index.tip_age_seconds);
    const warnings = index.warnings;
    return Array.isArray(warnings) && warnings.length > 0 && warnings.length <= 2
      && new Set(warnings).size === warnings.length
      && warnings.every(warning => warning === BLOCK_AGE_WARNING
        || (warning === VALIDATION_WAIT_WARNING && tip.headers > tip.height));
  } catch { return false; }
}
