import {
  getPendingFundingArweaveTxs,
  markArweaveTxFundingCredited,
  setArweaveTxFundingSent,
} from './tx';
import { fund, notifyIrys } from '../../arweave/signer';

export interface ReconcileResult {
  id: string;
  fundingTxHash: string;
  credited: boolean;
  error?: string;
}

// Top up Irys for this upload, persisting the funding tx on the doc before notify so
// a stranded credit is replayable, then marking it credited once notify succeeds.
// No-op when the balance cushion already covers the upload (fund returns null).
export async function fundUploadIfNeeded(uploadId: string, ETH: string): Promise<void> {
  if (!ETH || ETH === '0') return;
  const fundingTxHash = await fund(ETH, {
    onSent: (h) => setArweaveTxFundingSent(uploadId, { fundingTxHash: h, fundingETH: ETH }),
  });
  // Funding + notify already succeeded; marking credited is best-effort since
  // reconcile re-notifies idempotently and marks it later if this write fails.
  if (fundingTxHash) await markArweaveTxFundingCredited(uploadId).catch(() => undefined);
}

// Replay upload docs whose Irys funding was sent but never confirmed credited.
// notifyIrys is idempotent (an already-credited tx re-notify succeeds), so this is
// safe to run repeatedly. Sequential to stay gentle on the node; `dryRun` only lists.
export async function reconcilePendingIrysFunding({
  dryRun = false,
  limit = 100,
}: { dryRun?: boolean; limit?: number } = {}): Promise<{
  total: number;
  credited: number;
  results: ReconcileResult[];
}> {
  const pending = await getPendingFundingArweaveTxs(limit);
  const results: ReconcileResult[] = [];
  let consecutiveFailures = 0;
  for (const { id, fundingTxHash } of pending) {
    if (dryRun) {
      results.push({ id, fundingTxHash, credited: false });
      // eslint-disable-next-line no-continue
      continue;
    }
    // The node is likely down; the remaining notifies would fail identically,
    // each after a full retry ladder — bail out and let the next run retry.
    if (consecutiveFailures >= 3) break;
    try {
      // eslint-disable-next-line no-await-in-loop
      await notifyIrys(fundingTxHash);
      // eslint-disable-next-line no-await-in-loop
      await markArweaveTxFundingCredited(id);
      results.push({ id, fundingTxHash, credited: true });
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures += 1;
      results.push({
        id, fundingTxHash, credited: false, error: (err as Error).message,
      });
    }
  }
  return {
    total: pending.length,
    credited: results.filter((r) => r.credited).length,
    results,
  };
}

export default reconcilePendingIrysFunding;
