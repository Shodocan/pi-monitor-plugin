import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import {
  vetRegexPattern,
  ReDoSWorker,
  RedosTimeoutError,
  close,
} from '../src/runner/redos.ts';
import { REDOS_TIMEOUT_MS, REDOS_MAX_CONCURRENT } from '../src/limits.ts';

// ----------------------------------------------------------------
// Tests
// ----------------------------------------------------------------

describe('ReDoS vetting', () => {
  afterEach(async () => {
    await close().catch(() => {});
  }, 10000);

  // -- Safe patterns: matching -----------------------------------

  it('returns true for matching safe pattern', async () => {
    expect(await vetRegexPattern('hello')).toBe(true);
  });

  // -- Safe patterns: non-matching -------------------------------

  it('returns true for non-matching safe pattern', async () => {
    expect(await vetRegexPattern('\\d+')).toBe(true);
  });

  // -- Invalid regex rejection -----------------------------------

  it('rejects invalid regex patterns', async () => {
    await expect(vetRegexPattern('[invalid')).rejects.toThrow();
  });

  // -- Timeout / pathological rejection ----------------------------

  it('rejects pathological patterns that time out', async () => {
    await expect(vetRegexPattern('(a+)+')).rejects.toBeInstanceOf(RedosTimeoutError);
  });

  it('rejects another pathological pattern (nested quantifier)', async () => {
    await expect(vetRegexPattern('(a*)*')).rejects.toBeInstanceOf(RedosTimeoutError);
  });

  // -- Concurrency ------------------------------------------------

  it('handles concurrent vetting calls without deadlock', async () => {
    const calls = Array.from({ length: 4 }, (_, i) =>
      vetRegexPattern('safe' + i),
    );
    const results = await Promise.all(calls);
    expect(results.every((r) => r === true)).toBe(true);
  });

  // -- Worker cleanup / pool reuse ------------------------------

  it('cleans up workers and allows fresh pool after close()', async () => {
    await vetRegexPattern('cleanup');
    await close();
    const safe = await vetRegexPattern('after-close');
    expect(safe).toBe(true);
  });
});

// ----------------------------------------------------------------
// ReDoSWorker class API
// ----------------------------------------------------------------

describe('ReDoSWorker', () => {
  let worker: ReDoSWorker;

  beforeEach(() => {
    worker = new ReDoSWorker();
  });

  afterEach(async () => {
    await worker.close().catch(() => {});
  }, 10000);

  it('tests matching patterns', async () => {
    expect(await worker.test('hello', '', 'hello world', 1_000)).toBe(true);
  });

  it('tests non-matching patterns', async () => {
    expect(await worker.test('xyz', '', 'hello world', 1_000)).toBe(false);
  });

  it('respects regex flags', async () => {
    expect(await worker.test('hello', 'i', 'HELLO world', 1_000)).toBe(true);
  });

  it('times out on pathological input', async () => {
    await expect(
      worker.test('^(a+)+$', '', 'a'.repeat(32) + '!', 50),
    ).rejects.toBeInstanceOf(RedosTimeoutError);
  });

  it('rejects when pool is full', async () => {
    const pending = Array.from({ length: REDOS_MAX_CONCURRENT }, () =>
      worker.test('slow', '', 'a'.repeat(1_000_000)),
    );
    expect(() => worker.test('overflow', '', 'x')).toThrow('worker pool full');
    await Promise.allSettled(pending);
  });
});

// ----------------------------------------------------------------
// Constants
// ----------------------------------------------------------------

describe('constants', () => {
  it('REDOS_TIMEOUT_MS is 100 ms', () => {
    expect(REDOS_TIMEOUT_MS).toBe(100);
  });

  it('REDOS_MAX_CONCURRENT is 4', () => {
    expect(REDOS_MAX_CONCURRENT).toBe(4);
  });
});
