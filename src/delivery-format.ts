import crypto from 'node:crypto';
import type { FormatterOptions, FormattedDelivery, JobKind } from './types.ts';

const DEFAULT_MAX_PREVIEW = 200;

// ----------------------------------------------------------------
// Constants
// ----------------------------------------------------------------
const DIRECTIVE = 'monitor triggered.';
const NONCE_RE = /^[0-9a-f]{32}$/;

// ----------------------------------------------------------------
// Nonce generation
// ----------------------------------------------------------------

/**
 * Generate a high-entropy nonce (32 hex chars = 16 random bytes).
 */
export function generateNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

// ----------------------------------------------------------------
// ANSI / OSC / control sanitization
// ----------------------------------------------------------------
const ANSI_ESC_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
const ANSI_OSC_RE = /\x1b\][^\x07]*\x07/g;

/**
 * Remove ANSI escape sequences, carriage returns, and control characters
 * while preserving newlines and tabs.
 */
export function sanitize(text: string): string {
  return (
    text
      // Strip OSC sequences first
      .replace(ANSI_OSC_RE, '')
      // Strip CSI / other escape sequences
      .replace(ANSI_ESC_RE, '')
      // Strip carriage returns
      .replace(/\r/g, '')
      // Strip any remaining single control chars (except \n \t)
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '')
  );
}

// ----------------------------------------------------------------
// Best-effort secret redaction
// ----------------------------------------------------------------
const AUTH_BEARER_RE = /Authorization\s+Bearer\s+[\w.-]+/gi;
const URL_USERINFO_RE = /([\w.-]+:\/\/)([^\s@/]+)@/g;

// Groups: $1=boundary $2=key-quote $3=key-name $4=pre-separator whitespace
// $5=separator (: or =) $6=post-separator whitespace $7=value-quote $8=value.
const SECRET_PATTERN_RE =
  /([\s,;:{\[({=]|^)(["']?)((?:TOKEN|ACCESS_TOKEN|BEARER_TOKEN|PRIVATE_KEY|API_KEY|SECRET|PASSWORD))\2(\s*)([=:])(\s*)(["']?)([\w\-/.+%=@!$^*]+)\7/gi;

/**
 * Best-effort redaction of secrets in a string.
 * Replaces values after known key names and in common URL / header patterns.
 */
export function redactSecrets(text: string): string {
  // Key SEP value / "value" patterns — preserve boundary, key, separator, whitespace, quotes.
  text = text.replace(SECRET_PATTERN_RE, (_m, b, q1, key, ws1, sep, ws2, q2, _value) =>
    `${b}${q1}${key}${q1}${ws1}${sep}${ws2}${q2}****${q2}`,
  );

  // Authorization Bearer headers
  text = text.replace(AUTH_BEARER_RE, 'Authorization Bearer ****');

  // url://user:pass@host → url://****@host
  text = text.replace(URL_USERINFO_RE, '$1****@');

  return text;
}

// ----------------------------------------------------------------
// Preview truncator
// ----------------------------------------------------------------

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + '…';
}

/**
 * Detect whether `text` is already a nonce-fenced block.
 * Returns the unwrapped inner content if fenced, otherwise `undefined`.
 */
function unwrapNonceFence(text: string): string | undefined {
  const lines = text.split('\n');
  if (lines.length < 2) return undefined;
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (!NONCE_RE.test(first) || !NONCE_RE.test(last) || first !== last) return undefined;
  return lines.slice(1, -1).join('\n');
}

// ----------------------------------------------------------------
// Kind label helpers
// ----------------------------------------------------------------

function kindLabel(kind: JobKind | string): string {
  const labels: Record<JobKind, string> = {
    bg: 'background',
    mon: 'monitor',
    loop: 'loop',
    sched: 'schedule',
  };
  return labels[kind as JobKind] ?? kind;
}

// ----------------------------------------------------------------
// Job status (lightweight, delivery-only)
// ----------------------------------------------------------------
export interface JobStatus {
  jobID: string;
  kind: JobKind;
  status: string;
}

// ----------------------------------------------------------------
// Default options
// ----------------------------------------------------------------
const DEFAULT_OPTIONS: FormatterOptions = {
  maxPreviewLen: DEFAULT_MAX_PREVIEW,
};

// ----------------------------------------------------------------
// Public API
// ----------------------------------------------------------------

/**
 * Format a delivery payload into structured text.
 *
 * Nonce-fences untrusted process output. If `raw` is already a nonce-fenced
 * block, the inner content is unwrapped first to avoid nested fences.
 */
export function formatDelivery(raw: string, opts?: FormatterOptions): FormattedDelivery {
  const { nonce = generateNonce(), maxPreviewLen = DEFAULT_MAX_PREVIEW } = { ...DEFAULT_OPTIONS, ...opts };

  // If already nonce-fenced, unwrap to avoid nesting.
  const inner = unwrapNonceFence(raw);
  const sanitized = inner !== undefined ? sanitize(inner) : sanitize(raw);
  const redacted = redactSecrets(sanitized);

  const text = [
    nonce,
    DIRECTIVE,
    redacted,
    nonce,
  ].join('\n');

  return {
    text,
    commandPreview: redacted ? truncate(redacted, maxPreviewLen) : undefined,
    promptPreview: redacted ? truncate(redacted, maxPreviewLen) : undefined,
  };
}

/**
 * Format a collection of job statuses for delivery.
 */
export function formatJobs(jobs: JobStatus[], opts?: FormatterOptions): FormattedDelivery {
  const { nonce = generateNonce(), maxPreviewLen = DEFAULT_MAX_PREVIEW } = { ...DEFAULT_OPTIONS, ...opts };

  const parts: string[] = [];
  for (const job of jobs) {
    const label = kindLabel(job.kind);
    parts.push(`${job.jobID} (${label}) → ${job.status}`);
  }
  const body = parts.join('\n');
  const text = [
    nonce,
    DIRECTIVE,
    body,
    nonce,
  ].join('\n');

  return {
    text,
    commandPreview: truncate(body, maxPreviewLen),
    promptPreview: truncate(body, maxPreviewLen),
  };
}

/**
 * Format a cancel notification for delivery.
 */
export function formatCancel(jobID: string, kind: string, opts?: FormatterOptions): FormattedDelivery {
  const { nonce = generateNonce() } = { ...DEFAULT_OPTIONS, ...opts };
  const body = `${jobID} (${kindLabel(kind)}) → cancelled`;
  const text = [nonce, DIRECTIVE, body, nonce].join('\n');

  return {
    text,
    commandPreview: body,
    promptPreview: body,
  };
}
