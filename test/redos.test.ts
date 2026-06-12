import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

// ----------------------------------------------------------------
// vi.mock replaces worker_threads.Worker.
// _mock flags control mock behaviour at runtime.
// ----------------------------------------------------------------

const _mock = {
  exitBeforeOnline: false,
  constructorThrows: false,
};

vi.mock('worker_threads', async () => {
  const actual = await vi.importActual<typeof import('worker_threads')>('worker_threads');
  const ActualWorker = actual.Worker;

  return {
    ...actual,
    Worker: class extends (ActualWorker as any) {
      constructor(...args: any[]) {
        if (_mock.constructorThrows) {
          throw new Error('simulated Worker constructor failure');
        }
        if (_mock.exitBeforeOnline) {
          super(...args);
          // Defer 'exit' so the pool's .once('exit') listener attaches.
          // Use process.nextTick so it fires before 'online', guaranteeing
          // the premature-exit settle path is exercised.
          process.nextTick(() => this.emit('exit', 1));
          return;
        }
        super(...args);
      }
    },
  };
});

import {
  vetRegexPattern,
  ReDoSWorker,
  RedosTimeoutError,
  close,
} from '../src/runner/redos.ts';
import { REDOS_TIMEOUT_MS, REDOS_MAX_CONCURRENT } from '../src/limits.ts';

// ----------------------------------------------------------------
// ReDoS vetting (shared-pool API)
// ----------------------------------------------------------------

describe('ReDoS vetting', () => {
  afterEach(async () => {
    await close().catch(() => {});
  }, 10000);

  it('returns true for matching safe pattern', async () => {
    expect(await vetRegexPattern('hello')).toBe(true);
  });

  it('returns true for non-matching safe pattern', async () => {
    expect(await vetRegexPattern('\\d+')).toBe(true);
  });

  it('rejects invalid regex patterns', async () => {
    await expect(vetRegexPattern('[invalid')).rejects.toThrow();
  });

  it('rejects pathological patterns that time out', async () => {
    await expect(vetRegexPattern('(a+)+')).rejects.toBeInstanceOf(RedosTimeoutError);
  });

  it('rejects another pathological pattern (nested quantifier)', async () => {
    await expect(vetRegexPattern('(a*)*')).rejects.toBeInstanceOf(RedosTimeoutError);
  });

  it('handles concurrent vetting calls without deadlock', async () => {
    const calls = Array.from({ length: 4 }, (_, i) => vetRegexPattern('safe' + i));
    const results = await Promise.all(calls);
    expect(results.every((r) => r === true)).toBe(true);
  });

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

  // -- Premature worker exit (exit fires before online) ----------

  it('rejects with "worker exited prematurely" when worker exits before online', async () => {
    _mock.exitBeforeOnline = true;

    const w = new ReDoSWorker();
    const promise = w.test('premature', '', 'premature', 500);

    await expect(promise).rejects.toThrow('worker exited prematurely');

    _mock.exitBeforeOnline = false;

    // Pool slot was freed; subsequent call proceeds.
    const fresh = await w.test('after-exit', '', 'after-exit', 500);
    expect(fresh).toBe(true);
    await w.close();
  });

  it('frees pending slot after timeout so pool is not stuck', async () => {
    const w = new ReDoSWorker();
    const pathological = Array.from({ length: REDOS_MAX_CONCURRENT }, () =>
      w.test('(a+)+$', '', 'a'.repeat(64) + '!', 100),
    );

    expect(() => w.test('overflow', '', 'x')).toThrow('worker pool full');

    const results = await Promise.allSettled(pathological);
    expect(results.length).toBe(REDOS_MAX_CONCURRENT);

    const fresh = await w.test('recovered', '', 'recovered', 500);
    expect(fresh).toBe(true);
    await w.close();
  });

  it('decrements pending exactly once on settlement', async () => {
    const w = new ReDoSWorker();

    const fast = Array.from({ length: REDOS_MAX_CONCURRENT }, () =>
      w.test('ok', '', 'ok', 500),
    );
    expect(() => w.test('overflow', '', 'y')).toThrow('worker pool full');

    await Promise.all(fast);

    const recovered = Array.from({ length: REDOS_MAX_CONCURRENT }, () =>
      w.test('ok2', '', 'ok2', 500),
    );
    const results = await Promise.all(recovered);
    expect(results.length).toBe(REDOS_MAX_CONCURRENT);
    await w.close();
  });

  it('recovers from pathological worker that times out and exits', async () => {
    const w = new ReDoSWorker();

    const pathPromise = w.test('(a+)+$', '', 'a'.repeat(64) + '!', 100);
    const normal = Array.from({ length: 3 }, () =>
      w.test('normal', '', 'normal', 500),
    );

    await Promise.all(normal);

    const newCalls = Array.from({ length: 3 }, () =>
      w.test('new', '', 'new', 500),
    );
    const results = await Promise.all(newCalls);
    expect(results.length).toBe(3);

    await pathPromise.catch(() => {});

    const finalResult = await w.test('final', '', 'final', 500);
    expect(finalResult).toBe(true);
    await w.close();
  });

  // -- Worker constructor failure --------------------------------

  it('rejects immediately when Worker constructor fails and frees slot', async () => {
    _mock.constructorThrows = true;

    const w = new ReDoSWorker();

    // new Worker() throws → test() returns a rejected Promise.
    await expect(w.test('fail', '', 'fail', 500)).rejects.toThrow(
      'simulated Worker constructor failure',
    );

    _mock.constructorThrows = false;

    // Pool slot was freed; subsequent call succeeds.
    const recovered = await w.test('ok', '', 'ok', 500);
    expect(recovered).toBe(true);
    await w.close();
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
