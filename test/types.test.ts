import { describe, expect, it } from 'vitest';
import {
  MAX_ACTIVE_JOBS,
  MAX_COMPLETED_RETENTION,
  PROCESS_OUTPUT_CAP_LINES,
  PROCESS_OUTPUT_CAP_BYTES,
  MONITOR_RING_BUFFER_EVENTS,
  MONITOR_AFTER_WAIT_MS,
  MONITOR_DEBOUNCE_DEFAULT_MS,
  MONITOR_PER_DELIVERY_CAP_BYTES,
  MONITOR_PER_DELIVERY_CAP_EVENTS,
  MAX_REGEX_PATTERN_LENGTH,
  MIN_MONITOR_DEBOUNCE_S,
  MAX_MONITOR_DEBOUNCE_S,
  MIN_LOOP_INTERVAL_MS,
  MAX_SCHEDULE_HORIZON_MS,
  // MAX_PENDING_PER_JOB, MAX_PENDING_GLOBAL, MAX_QUEUE_BYTES_TOTAL — excluded:
  // OpenCode bridge FIFO queue caps; not enforced by Pi-native delivery (see src/limits.ts).
  REDOS_TIMEOUT_MS,
  REDOS_MAX_CONCURRENT,
  CANCEL_SIGKILL_TIMEOUT_MS,
} from '../src/limits.ts';
import type {
  JobKind,
  JobState,
  OutputEvent,
  JobRecord,
  FormatterOptions,
  FormattedDelivery,
  OutputStream,
} from '../src/types.ts';

describe('limits — PLAN.md §7 values', () => {
  it('exports all PLAN.md §7 constants', () => {
    expect(MAX_ACTIVE_JOBS).toBe(20);
    expect(MAX_COMPLETED_RETENTION).toBe(50);
    expect(PROCESS_OUTPUT_CAP_LINES).toBe(200);
    expect(PROCESS_OUTPUT_CAP_BYTES).toBe(32 * 1024);
    expect(MONITOR_RING_BUFFER_EVENTS).toBe(50_000);
    expect(MONITOR_AFTER_WAIT_MS).toBe(5_000);
    expect(MONITOR_DEBOUNCE_DEFAULT_MS).toBe(5_000);
    expect(MONITOR_PER_DELIVERY_CAP_BYTES).toBe(16 * 1024);
    expect(MONITOR_PER_DELIVERY_CAP_EVENTS).toBe(200);
    expect(MAX_REGEX_PATTERN_LENGTH).toBe(512);
    expect(MIN_MONITOR_DEBOUNCE_S).toBe(1);
    expect(MAX_MONITOR_DEBOUNCE_S).toBe(60);
    expect(MIN_LOOP_INTERVAL_MS).toBe(10_000);
    expect(MAX_SCHEDULE_HORIZON_MS).toBe(30 * 24 * 60 * 60 * 1000);
    // MAX_PENDING_PER_JOB, MAX_PENDING_GLOBAL, MAX_QUEUE_BYTES_TOTAL excluded:
    // OpenCode bridge FIFO queue caps; Pi-native delivery coalesces to one bucket per job.
    expect(REDOS_TIMEOUT_MS).toBe(100);
    expect(REDOS_MAX_CONCURRENT).toBe(4);
    expect(CANCEL_SIGKILL_TIMEOUT_MS).toBe(5_000);
  });
});

describe('types — runtime shape expectations', () => {
  it('JobKind accepts all four values', () => {
    const kinds: JobKind[] = ['bg', 'mon', 'loop', 'sched'];
    expect(kinds).toHaveLength(4);
  });

  it('JobState accepts all four values', () => {
    const states: JobState[] = ['active', 'completed', 'failed', 'cancelled'];
    expect(states).toHaveLength(4);
  });

  it('OutputEvent has the expected shape', () => {
    const evt: OutputEvent = {
      jobID: 'bg_1',
      seq: 1,
      stream: 'stdout',
      line: 'hello',
      timestamp: 1,
    };
    expect(evt.jobID).toBe('bg_1');
    expect(evt.stream).toBe('stdout');
  });

  it('JobRecord owns sessionID directly', () => {
    const rec: JobRecord = {
      jobID: 'mon_1',
      kind: 'mon',
      state: 'active',
      sessionID: 'sess-abc',
      createdAt: 0,
    };
    expect(rec.sessionID).toBe('sess-abc');
    expect(rec.kind).toBe('mon');
    expect(rec.state).toBe('active');
  });

  it('OutputStream accepts stdout and stderr', () => {
    const streams: OutputStream[] = ['stdout', 'stderr'];
    expect(streams).toHaveLength(2);
  });

  it('FormatterOptions accepts optional fields', () => {
    const opts: FormatterOptions = {};
    expect(opts).toEqual({});

    const full: FormatterOptions = { nonce: 'abc', maxPreviewLen: 40 };
    expect(full.nonce).toBe('abc');
    expect(full.maxPreviewLen).toBe(40);
  });

  it('FormattedDelivery accepts expected fields', () => {
    const fd: FormattedDelivery = { text: 'output' };
    expect(fd.text).toBe('output');

    const full: FormattedDelivery = {
      text: 'tail',
      commandPreview: 'sleep 2',
      promptPreview: undefined,
    };
    expect(full.commandPreview).toBe('sleep 2');
  });
});
