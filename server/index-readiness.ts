import { hash, integer, type RecordData } from './data';

interface AcceptedTip { height: number; hash: string; headers: number; }
const VALIDATION_WAIT_WARNING = 'TensorCash Core is still synchronizing the chain.';

export function indexSupportsAcceptedTip(index: RecordData, tip: AcceptedTip, now: number, maxTipAgeSeconds: number): boolean {
  try {
    if (index.core_online !== true || index.initial_block_download !== false || integer(index.lag_blocks) !== 0
      || integer(index.indexed_height) !== tip.height || hash(index.indexed_tip) !== tip.hash
      || Math.abs(now - integer(index.checked_at)) > 30) return false;
    if (index.ready === true) return true;
    // The observed explorer's generic syncing flag also covers new, unaccepted
    // headers. A complete index at Core's accepted tip remains usable in this
    // one explicit state; every other not-ready state continues to block.
    return index.ready === false && tip.headers > tip.height && index.state === 'syncing'
      && index.effective_work_ready === true && integer(index.core_height) === tip.height
      && integer(index.core_headers) === tip.headers && index.verification_progress === 1
      && integer(index.tip_age_seconds) <= maxTipAgeSeconds
      && Array.isArray(index.warnings) && index.warnings.length === 1 && index.warnings[0] === VALIDATION_WAIT_WARNING;
  } catch { return false; }
}
