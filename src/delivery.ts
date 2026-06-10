/**
 * Pi-native idle/busy delivery and loop coalescing.
 *
 * Implements PLAN.md §3.2:
 * - idle → sendMessage customType pi-monitor with triggerTurn true
 * - busy polite (default) → deliverAs nextTurn + UI toast
 * - busy interrupt → deliverAs steer
 * - loop tick coalescing by job ID while busy
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { formatDelivery } from './delivery-format.ts';
import type { JobKind } from './types.ts';

// ----------------------------------------------------------------
// Types
// ----------------------------------------------------------------

/** Delivery urgency for jobs. */
export type DeliveryUrgency = 'polite' | 'interrupt';

/** A pending delivery entry (queued while session is busy). */
export interface PendingDelivery {
  jobID: string;
  kind: JobKind;
  content: string;
  urgency: DeliveryUrgency;
  /** Whether this content is process output (nonce-fenced). */
  isProcessOutput: boolean;
  /** True if this is a loop tick that can be coalesced. */
  isLoopTick: boolean;
}

export function coalescedAnnotation(count: number): string {
  return `[coalesced ${count} loop ticks while session was busy]`;
}

// ----------------------------------------------------------------
// Coalescing state per job
// ----------------------------------------------------------------

interface CoalesceBucket {
  count: number;
  latest: PendingDelivery;
}

// ----------------------------------------------------------------
// Delivery service
// ----------------------------------------------------------------

export class DeliveryService {
  /** Loop tick coalescing buckets, keyed by jobID. */
  private coalesceBuckets: Map<string, CoalesceBucket> = new Map();

  /**
   * Deliver content to the Pi session using idle/busy-aware routing.
   *
   * @param content - The raw content to deliver.
   * @param isProcessOutput - True when content is process output (should be nonce-fenced).
   * @param urgency - Delivery urgency; defaults to 'polite'.
   * @param isLoopTick - True for loop ticks (enables coalescing while busy).
   */
  deliver(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    pending: PendingDelivery,
  ): void {
    const { isProcessOutput, content, jobID, isLoopTick } = pending;

    if (ctx.isIdle()) {
      // Idle: send immediately and trigger a turn.
      const text = isProcessOutput ? buildNonceFenced(content) : content;
      pi.sendMessage(
        { customType: 'pi-monitor', content: text, display: true },
        { triggerTurn: true },
      );
      return;
    }

    // Session is busy.
    if (isLoopTick) {
      coalesceLoopTick(this.coalesceBuckets, jobID, pending);
      return;
    }

    // Busy delivery.
    sendBusy(pi, ctx, pending);
  }

  /**
   * Attempt to flush coalesced loop ticks for a given job (called when session becomes idle).
   * Returns true if a coalesced delivery was sent.
   */
  flushCoalescedLoop(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    jobID: string,
  ): boolean {
    if (!ctx.isIdle()) {
      return false;
    }

    const bucket = this.coalesceBuckets.get(jobID);
    if (!bucket || bucket.count === 0) {
      return false;
    }

    const bucketCopy = { ...bucket };
    this.coalesceBuckets.delete(jobID);

    // Annotate with coalescing info.
    const annotation = coalescedAnnotation(bucketCopy.count);
    const base = bucketCopy.latest.isProcessOutput
      ? buildNonceFenced(bucketCopy.latest.content)
      : bucketCopy.latest.content;
    const content = `${annotation}\n${base}`;

    // Session is idle, trigger a turn.
    pi.sendMessage(
      { customType: 'pi-monitor', content, display: true },
      { triggerTurn: true },
    );
    return true;
  }

  /**
   * Clear all pending state (called on session shutdown).
   */
  clear(): void {
    this.coalesceBuckets.clear();
  }
}

// ----------------------------------------------------------------
// Internal helpers
// ----------------------------------------------------------------

function buildNonceFenced(raw: string): string {
  return formatDelivery(raw).text;
}

function sendBusy(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  pending: PendingDelivery,
): void {
  const { content, kind, jobID, isProcessOutput, urgency } = pending;
  const text = isProcessOutput ? buildNonceFenced(content) : content;

  if (urgency === 'interrupt') {
    pi.sendMessage(
      { customType: 'pi-monitor', content: text, display: true },
      { deliverAs: 'steer' },
    );
  } else {
    // Polite: nextTurn + best-effort UI toast.
    pi.sendMessage(
      { customType: 'pi-monitor', content: text, display: true },
      { deliverAs: 'nextTurn' },
    );
    notifyUiToast(ctx, kind, jobID);
  }
}

function coalesceLoopTick(
  buckets: Map<string, CoalesceBucket>,
  jobID: string,
  pending: PendingDelivery,
): void {
  const bucket = buckets.get(jobID);
  if (bucket) {
    bucket.count += 1;
    bucket.latest = pending;
  } else {
    buckets.set(jobID, { count: 1, latest: pending });
  }
}

function notifyUiToast(
  ctx: ExtensionContext,
  kind: PendingDelivery['kind'],
  jobID: string,
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(`${kind} ${jobID} ready (next turn)`);
  }
}
