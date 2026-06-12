/** PLAN.md §7 — ported limits. Bridge-only constants excluded. */

// Job registry
export const MAX_ACTIVE_JOBS = 20;
export const MAX_COMPLETED_RETENTION = 50;

// Process output caps
export const PROCESS_OUTPUT_CAP_LINES = 200;
export const PROCESS_OUTPUT_CAP_BYTES = 32 * 1024;

// Monitor limits
export const MONITOR_RING_BUFFER_EVENTS = 50_000;
export const MONITOR_AFTER_WAIT_MS = 5_000;
export const MONITOR_DEBOUNCE_DEFAULT_MS = 5_000;
export const MONITOR_PER_DELIVERY_CAP_BYTES = 16 * 1024;
export const MONITOR_PER_DELIVERY_CAP_EVENTS = 200;

// Regex limits
export const MAX_REGEX_PATTERN_LENGTH = 512;

// Monitor debounce range (seconds)
export const MIN_MONITOR_DEBOUNCE_S = 1;
export const MAX_MONITOR_DEBOUNCE_S = 60;

// Loop limits
export const MIN_LOOP_INTERVAL_MS = 10_000;

// Schedule limits
export const MAX_SCHEDULE_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;

// Delivery queue limits — excluded.
// OpenCode bridge FIFO queue caps (MAX_PENDING_PER_JOB, MAX_PENDING_GLOBAL, MAX_QUEUE_BYTES_TOTAL)
// are not ported: busy non-loop delivery is delegated to Pi nextTurn/steer, and loop delivery
// coalesces to one bucket per job (src/delivery.ts).

// ReDoS worker limits
export const REDOS_TIMEOUT_MS = 100;
export const REDOS_MAX_CONCURRENT = 4;

// Cancellation limits
export const CANCEL_SIGKILL_TIMEOUT_MS = 5_000;
