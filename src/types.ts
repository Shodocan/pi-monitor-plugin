/** Host-agnostic domain types. No bridge, HTTP, or MCP concepts. */

export type JobKind = 'bg' | 'mon' | 'loop' | 'sched';
export type JobState = 'active' | 'completed' | 'failed' | 'cancelled';

export type OutputStream = 'stdout' | 'stderr';

/** A single line of process output. */
export interface OutputEvent {
  jobID: string;
  seq: number;
  stream: OutputStream;
  line: string;
  timestamp: number;
}

/** Persistent job record — owns sessionID directly. */
export interface JobRecord {
  jobID: string;
  kind: JobKind;
  state: JobState;
  sessionID: string;
  createdAt: number;
}

/** Options for the delivery formatter. */
export interface FormatterOptions {
  nonce?: string;
  maxPreviewLen?: number;
}

/** Formatted payload delivered to a session. */
export interface FormattedDelivery {
  text: string;
  commandPreview?: string;
  promptPreview?: string;
}
