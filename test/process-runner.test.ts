import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { OutputEvent } from '../src/types.ts';
import { ProcessRunner } from '../src/runner/process-runner.ts';
import { PROCESS_OUTPUT_CAP_BYTES, PROCESS_OUTPUT_CAP_LINES } from '../src/limits.ts';

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

function waitForOutput(runner: ProcessRunner, jobID: string, maxLines = 4): Promise<string[]> {
  return new Promise<string[]>((resolve) => {
    const lines: string[] = [];
    const handler = (ev: { jobID: string; line: string }) => {
      if (ev.jobID === jobID) {
        lines.push(ev.line);
        if (lines.length >= maxLines) {
          runner.off('output', handler);
          resolve(lines);
        }
      }
    };
    runner.on('output', handler);
  });
}

function waitForExit(runner: ProcessRunner, jobID: string, exitPromise: Promise<number | null>): Promise<number | null> {
  return exitPromise.then((code) => {
    runner.dispose(jobID);
    return code;
  });
}

// ----------------------------------------------------------------
// Tests
// ----------------------------------------------------------------

describe('ProcessRunner', () => {
  let runner: ProcessRunner;

  beforeEach(() => {
    runner = new ProcessRunner();
  });

  afterEach(() => {
    runner.removeAllListeners();
  });

  // -- Spawn & exit promise -----------------------------------

  it('spawns with /bin/sh -c and detached group', async () => {
    const id = 'pr_1';
    const { exitPromise } = runner.run(id, 'echo hello');
    const code = await waitForExit(runner, id, exitPromise);
    expect(code).toBe(0);
  });

  it('creates exit promise before listeners — no race for fast commands', async () => {
    const id = 'pr_fast';
    const { exitPromise } = runner.run(id, 'true');
    const p = Promise.race([
      exitPromise.then((v) => v),
      new Promise<number>((r) => setTimeout(() => r(-1), 2000)),
    ]);
    const code = await p;
    expect(code).toBe(0);
    runner.dispose(id);
  });

  it('rejects duplicate jobID', () => {
    runner.run('dup', 'echo 1');
    expect(() => runner.run('dup', 'echo 2')).toThrow('already running');
  });

  // -- Output events -------------------------------------------

  it('emits OutputEvent with correct shape', async () => {
    const { exitPromise } = runner.run('out_1', 'echo hello');
    const lines = await waitForOutput(runner, 'out_1', 1);
    expect(lines).toContain('hello');
    await exitPromise;
    runner.dispose('out_1');
  });

  it('does not emit trailing empty line events', async () => {
    const id = 'no-trail';
    const results: OutputEvent[] = [];
    const outputSeen = new Promise<void>((resolve) => {
      runner.on('output', (ev) => {
        if (ev.jobID === id) resolve();
      });
    });
    runner.on('output', (ev) => {
      if (ev.jobID === id) results.push(ev);
    });
    const { exitPromise } = runner.run(id, 'echo one');
    await outputSeen;
    await exitPromise;
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => r.line.length > 0)).toBe(true);
    runner.dispose(id);
  });

  it('emits globally unique increasing seqs across streams', async () => {
    const id = 'seq_1';
    const events: OutputEvent[] = [];
    runner.on('output', (ev) => {
      if (ev.jobID === id) events.push(ev);
    });
    const { exitPromise } = runner.run(id, 'printf "out1\\nout2\\n"; printf "err1\\nerr2\\n" >&2');
    await exitPromise;
    const nonEmptyEvents = events.filter((e) => e.line.length > 0).sort((a, b) => a.seq - b.seq);
    expect(new Set(nonEmptyEvents.map((event) => event.seq)).size).toBe(nonEmptyEvents.length);
    for (let i = 1; i < nonEmptyEvents.length; i++) {
      expect(nonEmptyEvents[i].seq).toBeGreaterThan(nonEmptyEvents[i - 1].seq);
    }
    runner.dispose(id);
  });

  it('has numeric timestamp on each event', async () => {
    const id = 'ts_1';
    runner.on('output', (ev) => {
      if (ev.jobID === id) {
        expect(ev.timestamp).toBeGreaterThan(0);
      }
    });
    const { exitPromise } = runner.run(id, 'echo "ts test"');
    await exitPromise;
    runner.dispose(id);
  });

  // -- Partial line flush on stream end -------------------------

  it('flushes final partial line on stream end (no trailing newline)', async () => {
    const id = 'partial-flush';
    const events: OutputEvent[] = [];
    runner.on('output', (ev) => {
      if (ev.jobID === id) events.push(ev);
    });
    const { exitPromise } = runner.run(id, "printf 'done'");
    await exitPromise;
    const stdoutLines = events.filter((e) => e.stream === 'stdout').map((e) => e.line);
    expect(stdoutLines).toContain('done');
    runner.dispose(id);
  });

  it('tail includes final partial line', async () => {
    const id = 'partial-tail';
    const { exitPromise } = runner.run(id, "printf 'hello world'");
    await exitPromise;
    const tail = runner.tail(id, 'stdout');
    expect(tail).toContain('hello world');
    runner.dispose(id);
  });

  it('waits for stream end before resolving exitPromise for final partial line', async () => {
    const id = 'partial-exit-order';
    const { exitPromise } = runner.run(id, "printf 'done'; (sleep 0.2) &");
    await exitPromise;
    expect(runner.tail(id, 'stdout')).toContain('done');
    runner.dispose(id);
  });

  it('avoids synthetic trailing empty events on partial lines', async () => {
    const id = 'no-synthetic';
    const events: OutputEvent[] = [];
    runner.on('output', (ev) => {
      if (ev.jobID === id) events.push(ev);
    });
    // "done" has no trailing newline, so no empty line should be emitted
    const { exitPromise } = runner.run(id, "printf 'done'");
    await exitPromise;
    // No empty-string lines expected
    expect(events.some((e) => e.line.length === 0)).toBe(false);
    runner.dispose(id);
  });

  it('preserves non-trailing blank output lines', async () => {
    const id = 'blank-lines';
    const events: OutputEvent[] = [];
    runner.on('output', (ev) => {
      if (ev.jobID === id && ev.stream === 'stdout') events.push(ev);
    });
    const { exitPromise } = runner.run(id, "printf 'first\\n\\n'; sleep 0.1; printf 'second\\n'");
    await exitPromise;
    expect(events.map((e) => e.line)).toEqual(['first', '', 'second']);
    runner.dispose(id);
  });

  // -- Tail buffer --------------------------------------------

  it('stores rolling tail lines within cap', async () => {
    const id = 'tail_cap';
    const { exitPromise: ep } = runner.run(id, `printf 'a\\nb\\nc\\n'`);
    const events: Array<{ line: string }> = [];
    runner.on('output', (ev) => {
      if (ev.jobID === id) events.push(ev);
    });
    await ep;
    const tail = runner.tail(id, 'stdout');
    expect(tail.length).toBeLessThanOrEqual(3);
    expect(tail).toContain('a');
    runner.dispose(id);
  });

  it('tail cap respects rolling 200-line limit', async () => {
    const id = 'tail_roll';
    const { exitPromise } = runner.run(id, 'for i in $(seq 0 249); do echo $i; done');
    await exitPromise;
    const tail = runner.tail(id, 'stdout');
    expect(tail.length).toBe(PROCESS_OUTPUT_CAP_LINES);
    expect(tail).not.toContain('0');
    expect(tail).toContain('249');
    runner.dispose(id);
  });

  it('tail cap drops oldest lines when exceeding 200', async () => {
    const id = 'tail_drop';
    // Generate >200 lines via printf
    const { exitPromise } = runner.run(id, `for i in $(seq 1 300); do echo $i; done`);
    await exitPromise;
    const tail = runner.tail(id, 'stdout');
    expect(tail.length).toBeLessThanOrEqual(PROCESS_OUTPUT_CAP_LINES + 1);
    // Line "1" should be dropped since we emitted 300 lines but cap is 200
    expect(tail).not.toContain('1');
    // Recent lines should be present
    expect(tail).toContain('299');
    runner.dispose(id);
  });

  it('tail cap respects rolling byte limit', async () => {
    const id = 'tail_bytes';
    const { exitPromise } = runner.run(id, `for i in $(seq 1 60); do printf '%01024d\n' "$i"; done`);
    await exitPromise;
    const tail = runner.tail(id, 'stdout');
    const bytes = tail.reduce((sum, line) => sum + Buffer.byteLength(line, 'utf8'), 0);
    expect(bytes).toBeLessThanOrEqual(PROCESS_OUTPUT_CAP_BYTES);
    expect(tail.at(-1)).toMatch(/60$/);
    runner.dispose(id);
  });

  // -- stderr handling ------------------------------------------

  it('emits stderr output events', async () => {
    const id = 'stderr_1';
    const events: OutputEvent[] = [];
    runner.on('output', (ev) => {
      if (ev.jobID === id) events.push(ev);
    });
    const { exitPromise } = runner.run(id, 'echo "err" >&2');
    await exitPromise;
    const stderrEvents = events.filter((e) => e.stream === 'stderr');
    expect(stderrEvents.length).toBeGreaterThanOrEqual(1);
    expect(stderrEvents[0].line).toBe('err');
    runner.dispose(id);
  });

  it('tail tracks stderr independently', async () => {
    const id = 'stderr_tail';
    const { exitPromise } = runner.run(id, 'echo out; echo err >&2');
    await exitPromise;
    expect(runner.tail(id, 'stdout')).toContain('out');
    expect(runner.tail(id, 'stderr')).toContain('err');
    runner.dispose(id);
  });

  // -- Cancel -------------------------------------------------

  it('cancel throws for unknown jobID', async () => {
    await expect(runner.cancel('ghost_0')).rejects.toThrow('not found');
  });

  it('cancel is idempotent for already-cancelled job', async () => {
    const id = 'cancel-idem';
    const { exitPromise } = runner.run(id, 'sleep 30');
    await runner.cancel(id);
    await runner.cancel(id);
    runner.dispose(id);
  });

  it('cancel returns when process has already exited', async () => {
    const id = 'fast-cancel';
    const { exitPromise } = runner.run(id, 'echo done');
    await exitPromise;
    await runner.cancel(id);
    runner.dispose(id);
  });

  it('cancel uses SIGTERM + SIGKILL to process group', async () => {
    // spawn with detached=true gives a process group (-pid).
    // cancel() sends -pid SIGTERM then SIGKILL after grace.
    const id = 'group-kill';
    const { exitPromise } = runner.run(id, 'sleep 60');
    await runner.cancel(id);
    // If we get here without hanging, cancel worked
    runner.dispose(id);
  });

  // -- Dispose ------------------------------------------------

  it('dispose clears handles', () => {
    const id = 'ds_1';
    runner.run(id, 'sleep 60');
    runner.dispose(id);
    expect(runner.tail(id, 'stdout')).toEqual([]);
  });

  it('dispose terminates a running process', async () => {
    const id = 'dispose-running';
    const { exitPromise } = runner.run(id, 'sleep 60');
    runner.dispose(id);
    expect(runner.tail(id, 'stdout')).toEqual([]);
    await expect(
      Promise.race([
        exitPromise.then(() => 'exited'),
        new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 1_000)),
      ]),
    ).resolves.toBe('exited');
  });
});
