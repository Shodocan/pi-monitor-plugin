import type { JobKind, JobRecord } from './types.ts';

const KIND_ORDER: JobKind[] = ['bg', 'mon', 'loop', 'sched'];
const MAX_WIDGET_JOBS = 5;
const MAX_SUMMARY_CHARS = 52;

/** Compact footer status string for active jobs (e.g. "jobs mon:2 bg:1"). */
export function formatJobStatus(activeJobs: readonly JobRecord[]): string {
  if (activeJobs.length === 0) return 'jobs idle';

  const counts = new Map<JobKind, number>();
  for (const job of activeJobs) {
    counts.set(job.kind, (counts.get(job.kind) ?? 0) + 1);
  }

  const parts = KIND_ORDER.filter((kind) => counts.has(kind)).map((kind) => `${kind}:${counts.get(kind)}`);

  return `jobs ${parts.join(' ')}`;
}

/** Bounded widget lines for active jobs, or `undefined` when idle. */
export function formatJobWidget(activeJobs: readonly JobRecord[], now = Date.now()): string[] | undefined {
  if (activeJobs.length === 0) return undefined;

  const visible = activeJobs.slice(0, MAX_WIDGET_JOBS);
  const lines = ['pi-monitor jobs'];

  for (const job of visible) {
    const elapsed = formatElapsed(now - job.createdAt);
    const summary = truncate(job.summary ?? '', MAX_SUMMARY_CHARS);
    lines.push(summary ? `${job.jobID}  ${elapsed}  ${summary}` : `${job.jobID}  ${elapsed}`);
  }

  const hidden = activeJobs.length - visible.length;
  if (hidden > 0) lines.push(`…and ${hidden} more active jobs`);

  return lines;
}

/** Human-readable elapsed duration (s/m/h) clamped to non-negative input. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

/** Truncate a string to `maxChars`, appending an ellipsis when truncated. */
function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1)}…`;
}