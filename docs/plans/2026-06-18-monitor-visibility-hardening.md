# Monitor Visibility and Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make active pi-monitor jobs visible in the Pi TUI, notify the session when a monitor stops without explicit cancellation, and improve the GitHub PR watch skill with concise runnable examples.

**Architecture:** Keep changes session-local and minimal. Add job display metadata, pure UI formatting helpers, a single extension-side `updateJobUi(ctx)` helper, and an `isShuttingDown` guard so shutdown never emits stale monitor notifications. Monitor finalization classifies unrequested exit code `0` as a warning and non-zero/signal as an error, with capped recent output.

**Tech Stack:** TypeScript loaded by Pi via jiti, `@earendil-works/pi-coding-agent` extension APIs, TypeBox schemas, Node `child_process`, Vitest.

---

## Approved decisions and constraints

- User approved: **monitor exit code `0` still notifies as warning** because a monitor is expected to keep watching.
- Non-zero exit or signal notifies as error.
- Explicit `/cancel` and `session_shutdown` suppress stopped/died notifications.
- TUI uses compact footer status plus a small widget; no custom footer replacement.
- All output remains bounded, nonce-fenced/sanitized/redacted through the existing delivery path.
- No build step; Pi loads `extensions/*.ts` via jiti.
- Public repo docs/examples must use placeholders such as `acme-org/example-service`.

## File structure

- `src/types.ts` — add optional display metadata and process exit type.
- `src/registry.ts` — allow registering jobs with optional metadata.
- `src/ui.ts` — pure footer/widget formatting helpers.
- `src/runner/process-runner.ts` — return `{ code, signal }` from `exitPromise` using the existing `close` event.
- `extensions/pi-monitor.ts` — wire metadata, TUI updates, shutdown/cancel suppression, monitor stopped/died delivery, output capping.
- `test/ui.test.ts` — pure UI formatting tests.
- `test/registry.test.ts` — metadata tests.
- `test/process-runner.test.ts` — exit result tests.
- `test/pi-monitor-background-monitor.test.ts` — background/monitor status and monitor-death tests.
- `test/pi-monitor-loop-schedule.test.ts` — loop/schedule status tests.
- `skills/github-pr-watch/SKILL.md` — concise examples and parameter cheat sheet.

## Implementation tree

1. **Task 1** foundation: `src/types.ts`, `src/registry.ts`, `src/ui.ts`, `test/ui.test.ts`, `test/registry.test.ts`.
2. **Task 2** depends on Task 1 because it uses `ProcessExit`: `src/runner/process-runner.ts`, `test/process-runner.test.ts`.
3. **Task 3** depends on Task 1 and touches extension TUI wiring: `extensions/pi-monitor.ts`, extension tests.
4. **Task 4** depends on Tasks 1–3 and Task 2: monitor stopped/died notification in `extensions/pi-monitor.ts`, monitor tests.
5. **Task 5** docs-only and can be done independently: `skills/github-pr-watch/SKILL.md`.
6. **Task 6** final validation after Tasks 1–5.

---

### Task 1: Job display metadata and pure UI formatting

**Parallel:** no
**Touches:** `src/types.ts`, `src/registry.ts`, `src/ui.ts`, `test/ui.test.ts`, `test/registry.test.ts`

**Files:**
- Modify: `src/types.ts`
- Modify: `src/registry.ts`
- Create: `src/ui.ts`
- Create: `test/ui.test.ts`
- Modify: `test/registry.test.ts`

- [ ] **Step 1: Write failing UI formatter tests**

Create `test/ui.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { JobRecord } from '../src/types.ts';
import { formatJobStatus, formatJobWidget } from '../src/ui.ts';

function job(overrides: Partial<JobRecord>): JobRecord {
  return {
    jobID: 'mon_1',
    kind: 'mon',
    state: 'active',
    sessionID: 's1',
    createdAt: 1_000,
    ...overrides,
  };
}

describe('formatJobStatus', () => {
  it('returns idle when no active jobs exist', () => {
    expect(formatJobStatus([])).toBe('jobs idle');
  });

  it('summarizes active jobs by kind in a compact footer string', () => {
    expect(
      formatJobStatus([
        job({ jobID: 'bg_1', kind: 'bg' }),
        job({ jobID: 'mon_2', kind: 'mon' }),
        job({ jobID: 'mon_3', kind: 'mon' }),
        job({ jobID: 'loop_4', kind: 'loop' }),
      ]),
    ).toBe('jobs bg:1 mon:2 loop:1');
  });
});

describe('formatJobWidget', () => {
  it('hides the widget when no active jobs exist', () => {
    expect(formatJobWidget([], 10_000)).toBeUndefined();
  });

  it('renders bounded active job lines with elapsed time and truncated summary', () => {
    const lines = formatJobWidget(
      [
        job({
          jobID: 'mon_1',
          kind: 'mon',
          createdAt: 0,
          summary: 'watch-prs.sh --interval 300 --repo acme-org/example-service',
        }),
        job({ jobID: 'loop_2', kind: 'loop', createdAt: 3_000, summary: 'every 300s: check review queue' }),
      ],
      65_000,
    );

    expect(lines).toEqual([
      'pi-monitor jobs',
      'mon_1  1m  watch-prs.sh --interval 300 --repo acme-org/example…',
      'loop_2  1m  every 300s: check review queue',
    ]);
  });

  it('caps the active job list and reports hidden jobs', () => {
    const jobs = Array.from({ length: 7 }, (_, i) =>
      job({ jobID: `mon_${i + 1}`, kind: 'mon', summary: `monitor ${i + 1}` }),
    );

    const lines = formatJobWidget(jobs, 10_000);
    expect(lines).toHaveLength(7);
    expect(lines?.at(-1)).toBe('…and 2 more active jobs');
  });
});
```

- [ ] **Step 2: Write failing registry metadata test**

Add to `test/registry.test.ts`:

```ts
it('stores optional display summary for active jobs', () => {
  const r = new JobRegistry('session-1');

  const jobID = r.register('mon', { summary: 'watch-prs.sh --interval 300' });

  expect(r.get(jobID)).toMatchObject({
    jobID,
    kind: 'mon',
    state: 'active',
    summary: 'watch-prs.sh --interval 300',
  });
});
```

- [ ] **Step 3: Run focused tests to verify failure**

```bash
npm test -- test/ui.test.ts test/registry.test.ts
```

Expected: `src/ui.ts` import fails and `JobRegistry.register()` does not accept metadata yet.

- [ ] **Step 4: Add metadata and process-exit types**

Modify the top of `src/types.ts` to include:

```ts
export type JobKind = 'bg' | 'mon' | 'loop' | 'sched';
export type JobState = 'active' | 'completed' | 'failed' | 'cancelled';

export interface JobMetadata {
  summary?: string;
}

export interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface JobRecord extends JobMetadata {
  jobID: string;
  kind: JobKind;
  state: JobState;
  sessionID: string;
  createdAt: number;
}
```

Keep existing `OutputEvent`, `FormatterOptions`, and `FormattedDelivery` definitions.

- [ ] **Step 5: Update registry register signature**

Modify `src/registry.ts`:

```ts
import type { JobKind, JobMetadata, JobRecord } from './types.ts';

// inside JobRegistry
register(kind: JobKind, metadata: JobMetadata = {}): string {
  if (this.#active.size >= MAX_ACTIVE_JOBS) {
    throw new Error(`max active jobs (${MAX_ACTIVE_JOBS})`);
  }

  this.#counter += 1;
  const jobID = `${kind}_${this.#counter}`;
  const record: JobRecord = {
    jobID,
    kind,
    state: 'active',
    sessionID: this.#sessionID,
    createdAt: Date.now(),
    ...metadata,
  };

  this.#active.set(jobID, record);
  return jobID;
}
```

- [ ] **Step 6: Create pure UI helper**

Create `src/ui.ts`:

```ts
import type { JobKind, JobRecord } from './types.ts';

const KIND_ORDER: JobKind[] = ['bg', 'mon', 'loop', 'sched'];
const MAX_WIDGET_JOBS = 5;
const MAX_SUMMARY_CHARS = 56;

export function formatJobStatus(activeJobs: readonly JobRecord[]): string {
  if (activeJobs.length === 0) return 'jobs idle';

  const counts = new Map<JobKind, number>();
  for (const job of activeJobs) {
    counts.set(job.kind, (counts.get(job.kind) ?? 0) + 1);
  }

  const parts = KIND_ORDER
    .filter((kind) => counts.has(kind))
    .map((kind) => `${kind}:${counts.get(kind)}`);

  return `jobs ${parts.join(' ')}`;
}

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

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1)}…`;
}
```

- [ ] **Step 7: Run focused tests to verify pass**

```bash
npm test -- test/ui.test.ts test/registry.test.ts
```

Expected: both files pass.

- [ ] **Step 8: Commit Task 1**

```bash
git add src/types.ts src/registry.ts src/ui.ts test/ui.test.ts test/registry.test.ts
git commit -m "feat: add monitor job UI formatting"
```

---

### Task 2: Process exit result with code and signal

**Parallel:** after Task 1
**Touches:** `src/runner/process-runner.ts`, `test/process-runner.test.ts`

**Files:**
- Modify: `src/runner/process-runner.ts`
- Modify: `test/process-runner.test.ts`

- [ ] **Step 1: Write failing process-exit tests**

In `test/process-runner.test.ts`, import `ProcessExit`, update the helper signature, and add two tests near existing exit/cancel tests:

```ts
import type { ProcessExit } from '../src/types.ts';

function waitForExit(
  runner: ProcessRunner,
  jobID: string,
  exitPromise: Promise<ProcessExit>,
): Promise<ProcessExit> {
  return exitPromise.then((result) => {
    runner.dispose(jobID);
    return result;
  });
}

it('returns exit code and null signal for natural completion', async () => {
  const runner = new ProcessRunner();
  const id = 'exit-code';

  const { exitPromise } = runner.run(id, 'exit 7');
  const result = await waitForExit(runner, id, exitPromise);

  expect(result).toEqual({ code: 7, signal: null });
});

it('returns null code and signal for cancellation', async () => {
  const runner = new ProcessRunner();
  const id = 'exit-signal';

  const { exitPromise } = runner.run(id, 'sleep 60');
  await runner.cancel(id);
  const result = await exitPromise;

  expect(result.code).toBeNull();
  expect(result.signal).toBeTruthy();
  runner.dispose(id);
});
```

- [ ] **Step 2: Run focused test to verify failure**

```bash
npm test -- test/process-runner.test.ts
```

Expected: assertions or TypeScript fail because `exitPromise` currently resolves `number | null`.

- [ ] **Step 3: Update ProcessRunner result type**

Modify `src/runner/process-runner.ts`:

```ts
import type { OutputEvent, OutputStream, ProcessExit } from '../types.ts';

interface ProcessHandle {
  process: ChildProcess;
  exitPromise: Promise<ProcessExit>;
  cancelPending: boolean;
  cancelled: boolean;
}

run(jobID: string, command: string): { jobID: string; exitPromise: Promise<ProcessExit> } {
  if (this.#handles.has(jobID)) {
    throw new ProcessRunnerError(`job ${jobID} already running`);
  }

  const child = spawn('/bin/sh', ['-c', command], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });

  const exitPromise = new Promise<ProcessExit>((resolve) => {
    child.once('close', (code, signal) => {
      resolve({ code, signal });
    });
  });

  void this.#onSpawn(jobID, child, exitPromise);
  return { jobID, exitPromise };
}

#onSpawn(jobID: string, child: ChildProcess, exitPromise: Promise<ProcessExit>): void {
  // existing body unchanged
}
```

- [ ] **Step 4: Run focused tests**

```bash
npm test -- test/process-runner.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/runner/process-runner.ts test/process-runner.test.ts
git commit -m "feat: expose process exit result"
```

---

### Task 3: Wire TUI status/widget updates through the extension

**Parallel:** after Tasks 1 and 2
**Touches:** `extensions/pi-monitor.ts`, `test/pi-monitor-background-monitor.test.ts`, `test/pi-monitor-loop-schedule.test.ts`

**Files:**
- Modify: `extensions/pi-monitor.ts`
- Modify: `test/pi-monitor-background-monitor.test.ts`
- Modify: `test/pi-monitor-loop-schedule.test.ts`

- [ ] **Step 1: Add `setWidget` to extension test mocks**

In both `test/pi-monitor-background-monitor.test.ts` and `test/pi-monitor-loop-schedule.test.ts`, update `makeMockContext()` UI mock:

```ts
ui: {
  setStatus: vi.fn(),
  setWidget: vi.fn(),
  notify: vi.fn(),
  select: vi.fn(),
  confirm: vi.fn(),
  input: vi.fn(),
},
```

- [ ] **Step 2: Add failing status/widget tests for all job kinds**

Add to `test/pi-monitor-background-monitor.test.ts`:

```ts
it('updates TUI status and widget while a background job is active', async () => {
  await startSession(api, ctx);

  const result = await tool(api, 'jobs_background').execute(
    'call-bg-ui',
    { command: 'sleep 0.2' },
    undefined,
    undefined,
    ctx,
  );

  const jobID = (result.content[0].text as string).match(/started (\S+)/)![1];
  expect(ctx.ui.setStatus).toHaveBeenLastCalledWith('pi-monitor', 'jobs bg:1');
  expect(ctx.ui.setWidget).toHaveBeenLastCalledWith(
    'pi-monitor',
    expect.arrayContaining(['pi-monitor jobs', expect.stringContaining(jobID)]),
  );

  await vi.waitFor(() => expect(ctx.ui.setStatus).toHaveBeenLastCalledWith('pi-monitor', 'jobs idle'));
  expect(ctx.ui.setWidget).toHaveBeenLastCalledWith('pi-monitor', undefined);
  await shutdownSession(api);
});

it('updates TUI status and widget when a monitor job starts and is cancelled', async () => {
  await startSession(api, ctx);

  const result = await tool(api, 'jobs_monitor').execute(
    'call-mon-ui',
    { command: 'sleep 60', regex: 'PI_EVENT', debounceSeconds: 1 },
    undefined,
    undefined,
    ctx,
  );

  const jobID = (result.content[0].text as string).match(/started (\S+)/)![1];
  expect(ctx.ui.setStatus).toHaveBeenLastCalledWith('pi-monitor', 'jobs mon:1');
  expect(ctx.ui.setWidget).toHaveBeenLastCalledWith(
    'pi-monitor',
    expect.arrayContaining(['pi-monitor jobs', expect.stringContaining(jobID)]),
  );

  await tool(api, 'jobs_cancel').execute('cancel-mon-ui', { jobID }, undefined, undefined, ctx);
  expect(ctx.ui.setStatus).toHaveBeenLastCalledWith('pi-monitor', 'jobs idle');
  expect(ctx.ui.setWidget).toHaveBeenLastCalledWith('pi-monitor', undefined);
  await shutdownSession(api);
});
```

Add to `test/pi-monitor-loop-schedule.test.ts`:

```ts
it('updates TUI status and widget when a loop job starts and is cancelled', async () => {
  await startSession(api, ctx);

  const result = await tool(api, 'jobs_loop').execute(
    'call-loop-ui',
    { intervalSeconds: 30, prompt: 'check review queue' },
    undefined,
    undefined,
    ctx,
  );

  const jobID = result.content[0].text.replace('started ', '');
  expect(ctx.ui.setStatus).toHaveBeenLastCalledWith('pi-monitor', 'jobs loop:1');
  expect(ctx.ui.setWidget).toHaveBeenLastCalledWith(
    'pi-monitor',
    expect.arrayContaining(['pi-monitor jobs', expect.stringContaining(jobID)]),
  );

  await tool(api, 'jobs_cancel').execute('cancel-loop-ui', { jobID }, undefined, undefined, ctx);
  expect(ctx.ui.setStatus).toHaveBeenLastCalledWith('pi-monitor', 'jobs idle');
  expect(ctx.ui.setWidget).toHaveBeenLastCalledWith('pi-monitor', undefined);
  await shutdownSession(api);
});

it('updates TUI status and widget when a scheduled job starts and is cancelled', async () => {
  await startSession(api, ctx);

  const result = await tool(api, 'jobs_schedule').execute(
    'call-sched-ui',
    { inSeconds: 30, prompt: 'check later' },
    undefined,
    undefined,
    ctx,
  );

  const jobID = result.content[0].text.replace('started ', '');
  expect(ctx.ui.setStatus).toHaveBeenLastCalledWith('pi-monitor', 'jobs sched:1');
  expect(ctx.ui.setWidget).toHaveBeenLastCalledWith(
    'pi-monitor',
    expect.arrayContaining(['pi-monitor jobs', expect.stringContaining(jobID)]),
  );

  await tool(api, 'jobs_cancel').execute('cancel-sched-ui', { jobID }, undefined, undefined, ctx);
  expect(ctx.ui.setStatus).toHaveBeenLastCalledWith('pi-monitor', 'jobs idle');
  expect(ctx.ui.setWidget).toHaveBeenLastCalledWith('pi-monitor', undefined);
  await shutdownSession(api);
});
```

- [ ] **Step 3: Run focused tests to verify failure**

```bash
npm test -- test/pi-monitor-background-monitor.test.ts test/pi-monitor-loop-schedule.test.ts
```

Expected: status/widget expectations fail because the extension only sets initial status.

- [ ] **Step 4: Import UI helpers and process type**

Modify `extensions/pi-monitor.ts` imports:

```ts
import type { OutputEvent, JobRecord, ProcessExit } from '../src/types.ts';
import { formatJobStatus, formatJobWidget } from '../src/ui.ts';
```

- [ ] **Step 5: Add shutdown/context state and update helper**

Inside the extension factory:

```ts
let isShuttingDown = false;
let activeCtx: ExtensionContext | null = null;
```

In `session_start`:

```ts
isShuttingDown = false;
activeCtx = ctx;
registry = new JobRegistry(ctx.sessionManager.getSessionId());
// existing setup...
updateJobUi(ctx);
```

Add helper near shared handlers:

```ts
function updateJobUi(ctx: ExtensionContext): void {
  if (!ctx.hasUI || !registry || isShuttingDown) return;
  const activeJobs = registry.active();
  ctx.ui.setStatus('pi-monitor', formatJobStatus(activeJobs));
  ctx.ui.setWidget('pi-monitor', formatJobWidget(activeJobs));
}

function clearJobUi(): void {
  const ctx = activeCtx;
  if (!ctx?.hasUI) return;
  try {
    ctx.ui.setStatus('pi-monitor', undefined);
    ctx.ui.setWidget('pi-monitor', undefined);
  } catch {
    // Session may already be tearing down; UI cleanup is best-effort.
  }
}
```

In `session_shutdown`, set the guard first, clear UI best-effort, cancel active processes with the real SIGTERM → SIGKILL path, and then drop refs:

```ts
pi.on('session_shutdown', async () => {
  isShuttingDown = true;
  clearJobUi();

  if (scheduler) {
    scheduler.destroy();
    scheduler = null;
  }

  if (registry && runner) {
    const activeRunnerJobs = registry.active().filter((job) => job.kind === 'bg' || job.kind === 'mon');
    for (const job of activeRunnerJobs) {
      try {
        registry.cancel(job.jobID);
      } catch {
        // Already completed/cancelled; shutdown continues.
      }
    }
    await Promise.allSettled(activeRunnerJobs.map((job) => runner!.cancel(job.jobID)));
    for (const job of activeRunnerJobs) runner.dispose(job.jobID);
  }

  if (engines) {
    for (const engine of engines.values()) engine.destroy();
    engines.clear();
  }

  delivery?.clear();
  delivery = null;
  await closeRedos();
  engines = null;
  runner = null;
  registry = null;
  activeCtx = null;
});
```

- [ ] **Step 6: Register jobs with display summaries and update UI**

Use these summaries:

```ts
const jobID = r.register('bg', { summary: command });
updateJobUi(ctx);
```

```ts
const jobID = r.register('mon', { summary: `${regex.toString()} -- ${command}` });
updateJobUi(ctx);
```

```ts
const jobID = r.register('loop', { summary: `every ${Math.floor(intervalMs / 1_000)}s: ${prompt}` });
updateJobUi(ctx);
```

```ts
const jobID = r.register('sched', { summary: `at ${runAt.toISOString()}: ${prompt}` });
updateJobUi(ctx);
```

After each `r.complete(...)`, `r.fail(...)`, and successful `r.cancel(...)`, call `updateJobUi(ctx)` unless `isShuttingDown`.

In `deliverPrompt()`, after schedule completion/failure:

```ts
if (req.kind === 'sched') {
  registryRef.complete(req.jobID);
  updateJobUi(ctx);
}
```

And in its catch:

```ts
if (req.kind === 'sched') {
  registryRef.fail(req.jobID);
  updateJobUi(ctx);
}
```

- [ ] **Step 7: Run focused extension tests**

```bash
npm test -- test/pi-monitor-background-monitor.test.ts test/pi-monitor-loop-schedule.test.ts
```

Expected: pass.

- [ ] **Step 8: Commit Task 3**

```bash
git add extensions/pi-monitor.ts test/pi-monitor-background-monitor.test.ts test/pi-monitor-loop-schedule.test.ts
git commit -m "feat: show active monitor jobs in TUI"
```

---

### Task 4: Notify on unrequested monitor stop/death

**Parallel:** after Tasks 1, 2, and 3
**Touches:** `extensions/pi-monitor.ts`, `test/pi-monitor-background-monitor.test.ts`

**Files:**
- Modify: `extensions/pi-monitor.ts`
- Modify: `test/pi-monitor-background-monitor.test.ts`

- [ ] **Step 1: Add failing warning notification test for code 0**

Add to `test/pi-monitor-background-monitor.test.ts`:

```ts
it('notifies when a monitor exits normally without being cancelled', async () => {
  await startSession(api, ctx);

  const result = await tool(api, 'jobs_monitor').execute(
    'call-mon-stopped',
    { command: 'sh -c "sleep 0.1; exit 0"', regex: 'NEVER_MATCHES', debounceSeconds: 1 },
    undefined,
    undefined,
    ctx,
  );

  const jobID = (result.content[0].text as string).match(/started (\S+)/)![1];

  await vi.waitFor(() => {
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining(`${jobID} monitor stopped`), 'warning');
  });

  expect(api.sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({ customType: 'pi-monitor', content: expect.stringContaining('monitor stopped'), display: true }),
    { triggerTurn: true },
  );

  await shutdownSession(api);
});
```

- [ ] **Step 2: Add failing error notification and tail cap test for non-zero exit**

Add to `test/pi-monitor-background-monitor.test.ts`:

```ts
it('notifies when a monitor dies with a non-zero exit and caps recent output', async () => {
  await startSession(api, ctx);
  const noisy = "node -e \"console.error('x'.repeat(20000)); process.exit(7)\"";

  const result = await tool(api, 'jobs_monitor').execute(
    'call-mon-died',
    { command: noisy, regex: 'NEVER_MATCHES', debounceSeconds: 1 },
    undefined,
    undefined,
    ctx,
  );

  const jobID = (result.content[0].text as string).match(/started (\S+)/)![1];

  await vi.waitFor(() => {
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining(`${jobID} monitor died`), 'error');
  });

  const message = vi.mocked(api.sendMessage).mock.calls.find(([payload]) => {
    return typeof payload.content === 'string' && payload.content.includes('monitor died');
  });

  expect(message?.[0]).toMatchObject({ customType: 'pi-monitor', display: true });
  expect(message?.[0].content).toContain('exit code 7');
  expect(Buffer.byteLength(String(message?.[0].content), 'utf8')).toBeLessThanOrEqual(17 * 1024);

  await shutdownSession(api);
});
```

- [ ] **Step 3: Add failing explicit-cancel suppression test**

Add to `test/pi-monitor-background-monitor.test.ts`:

```ts
it('does not send monitor output or death notification after explicit cancel', async () => {
  await startSession(api, ctx);

  const result = await tool(api, 'jobs_monitor').execute(
    'call-mon-cancel-no-death',
    { command: 'bash -c \'trap "" TERM; printf "MATCH_BEFORE_CANCEL\\n"; while true; do sleep 1; done\'', regex: 'MATCH_BEFORE_CANCEL', debounceSeconds: 1 },
    undefined,
    undefined,
    ctx,
  );

  const jobID = (result.content[0].text as string).match(/started (\S+)/)![1];
  await new Promise((resolve) => setTimeout(resolve, 50));
  await tool(api, 'jobs_cancel').execute('cancel-no-death', { jobID }, undefined, undefined, ctx);
  await new Promise((resolve) => setTimeout(resolve, 1_100));

  const allMessages = [
    ...vi.mocked(ctx.ui.notify).mock.calls.map((call) => String(call[0])),
    ...vi.mocked(api.sendMessage).mock.calls.map((call) => String(call[0].content)),
  ].join('\n');

  expect(allMessages).not.toContain('monitor died');
  expect(allMessages).not.toContain('monitor stopped');
  expect(allMessages).not.toContain('MATCH_BEFORE_CANCEL');
  await shutdownSession(api);
});
```

- [ ] **Step 4: Add failing shutdown suppression test**

Add to `test/pi-monitor-background-monitor.test.ts`:

```ts
it('does not send monitor output or death notification during session shutdown', async () => {
  await startSession(api, ctx);

  await tool(api, 'jobs_monitor').execute(
    'call-mon-shutdown-no-death',
    { command: 'bash -c \'trap "" TERM; printf "MATCH_BEFORE_SHUTDOWN\\n"; while true; do sleep 1; done\'', regex: 'MATCH_BEFORE_SHUTDOWN', debounceSeconds: 1 },
    undefined,
    undefined,
    ctx,
  );

  await new Promise((resolve) => setTimeout(resolve, 50));
  await shutdownSession(api);
  await new Promise((resolve) => setTimeout(resolve, 1_100));

  const allMessages = [
    ...vi.mocked(ctx.ui.notify).mock.calls.map((call) => String(call[0])),
    ...vi.mocked(api.sendMessage).mock.calls.map((call) => String(call[0].content)),
  ].join('\n');

  expect(allMessages).not.toContain('monitor died');
  expect(allMessages).not.toContain('monitor stopped');
  expect(allMessages).not.toContain('MATCH_BEFORE_SHUTDOWN');
});
```

- [ ] **Step 5: Run focused tests to verify failure**

```bash
npm test -- test/pi-monitor-background-monitor.test.ts
```

Expected: new notification/suppression tests fail.

- [ ] **Step 6: Import per-delivery cap and add helpers**

Modify `extensions/pi-monitor.ts` imports from `../src/limits.ts` to include:

```ts
MONITOR_PER_DELIVERY_CAP_BYTES,
```

Add helpers near shared handlers:

```ts
const MONITOR_EXIT_HEADROOM_BYTES = 1024;

function isCleanExit(exit: ProcessExit): boolean {
  return exit.code === 0 && exit.signal === null;
}

function exitReason(exit: ProcessExit): string {
  if (exit.signal) return `signal ${exit.signal}`;
  return `exit code ${exit.code ?? 'unknown'}`;
}

function capRecentOutput(tail: string): string {
  const maxBytes = Math.max(0, MONITOR_PER_DELIVERY_CAP_BYTES - MONITOR_EXIT_HEADROOM_BYTES);
  const bytes = Buffer.from(tail, 'utf8');
  if (bytes.length <= maxBytes) return tail;
  return `[truncated recent output to ${maxBytes} bytes]\n${bytes.subarray(bytes.length - maxBytes).toString('utf8')}`;
}

function monitorExitContent(jobID: string, exit: ProcessExit, tail: string): string {
  const headline = isCleanExit(exit)
    ? `${jobID} monitor stopped (${exitReason(exit)}); no longer watching.`
    : `${jobID} monitor died (${exitReason(exit)}); no longer watching.`;
  const cappedTail = capRecentOutput(tail);
  return cappedTail.length > 0 ? `${headline}\n\nRecent output:\n${cappedTail}` : headline;
}

function notifyMonitorExit(
  ctx: ExtensionContext,
  deliveryRef: DeliveryService,
  jobID: string,
  exit: ProcessExit,
  tail: string,
): void {
  if (isShuttingDown) return;
  const clean = isCleanExit(exit);
  const label = clean ? `${jobID} monitor stopped` : `${jobID} monitor died`;
  if (ctx.hasUI) ctx.ui.notify(label, clean ? 'warning' : 'error');

  deliveryRef.deliver(pi, ctx, {
    jobID,
    kind: 'mon',
    content: monitorExitContent(jobID, exit, tail),
    urgency: clean ? 'polite' : 'interrupt',
    isProcessOutput: true,
    isLoopTick: false,
  });
}
```

- [ ] **Step 7: Wire helpers into monitor output and finalizer**

In `handleMonitor()`, change `let exitPromise` to `Promise<ProcessExit>`. Also guard monitor window delivery so shutdown cannot flush pending matches into a stale session:

```ts
onWindow: (window) => {
  if (isShuttingDown || r.get(jobID)?.state !== 'active') return;
  const lines = window.events.map((e) => e.line).join('\n');
  deliveryRef.deliver(pi, ctx, {
    jobID,
    kind: 'mon',
    content: lines,
    urgency,
    isProcessOutput: true,
    isLoopTick: false,
  });
},
```

Replace the monitor async finalizer with:

```ts
(async () => {
  try {
    const exit = await exitPromise;

    if (isShuttingDown) return;

    const latest = r.get(jobID);
    const wasStillActive = latest?.state === 'active';
    if (!wasStillActive) return;

    engine.flush();
    if (isShuttingDown) return;

    const tail = runnerRef.tail(jobID, 'stdout').concat(runnerRef.tail(jobID, 'stderr')).join('\n');

    notifyMonitorExit(ctx, deliveryRef, jobID, exit, tail);
    if (isCleanExit(exit)) {
      r.complete(jobID);
    } else {
      r.fail(jobID);
    }
    updateJobUi(ctx);
  } catch {
    if (!isShuttingDown) {
      r.fail(jobID);
      updateJobUi(ctx);
    }
  } finally {
    if (onOutput) runnerRef.removeListener('output', onOutput);
    engine.destroy();
    enginesRef.delete(jobID);
    runnerRef.dispose(jobID);
  }
})().catch(() => {});
```

- [ ] **Step 8: Ensure cancel and shutdown suppression remain explicit**

Keep `handleCancel()` destroying/removing the monitor engine promptly, then marking registry cancelled before awaiting process teardown:

```ts
const engine = enginesRef.get(jobID);
if (engine) {
  engine.destroy();
  enginesRef.delete(jobID);
}
r.cancel(jobID);
updateJobUi(ctx);
```

Keep `session_shutdown` setting `isShuttingDown = true` before any engine flush, delivery, registry transition, runner cancellation, or disposal. Shutdown must use `runner.cancel(jobID)` before final `runner.dispose(jobID)` for active process jobs so the SIGTERM → SIGKILL grace path is preserved.

- [ ] **Step 9: Run focused tests**

```bash
npm test -- test/pi-monitor-background-monitor.test.ts
```

Expected: pass.

- [ ] **Step 10: Commit Task 4**

```bash
git add extensions/pi-monitor.ts test/pi-monitor-background-monitor.test.ts
git commit -m "fix: notify when monitors stop watching"
```

---

### Task 5: Improve GitHub PR watch skill examples

**Parallel:** yes
**Touches:** `skills/github-pr-watch/SKILL.md`

**Files:**
- Modify: `skills/github-pr-watch/SKILL.md`

- [ ] **Step 1: Replace the start section with concise examples**

Replace `## Start watching` in `skills/github-pr-watch/SKILL.md` with:

````md
## Start watching

1. **Resolve scope.**
   - User said "this repo" or you are inside a repo: run
     `gh repo view --json nameWithOwner -q .nameWithOwner` and use `--repo <owner/name>`.
   - User said "my PRs", "everything", or gave no repo: use cross-repo mode without `--repo`.
2. **Pick interval.** Default 300 seconds. Minimum practical interval is 60 seconds because `gh search` indexing may lag.
3. **Start monitor.** Use the absolute script path from this skill directory.

### Slash examples

Watch review requests across all repos every 5 minutes:

```text
/monitor --regex '^PI_EVENT ' -- <skill-dir>/scripts/watch-prs.sh --interval 300
```

Watch one repo:

```text
/monitor --regex '^PI_EVENT ' -- <skill-dir>/scripts/watch-prs.sh --interval 300 --repo acme-org/example-service
```

Include drafts or bot-authored PRs:

```text
/monitor --regex '^PI_EVENT ' -- <skill-dir>/scripts/watch-prs.sh --interval 300 --include-drafts --include-bots
```

### Tool example

```json
{
  "command": "<skill-dir>/scripts/watch-prs.sh --interval 300 --repo acme-org/example-service",
  "regex": "^PI_EVENT ",
  "before": 0,
  "after": 0,
  "debounceSeconds": 5,
  "deliver": "polite"
}
```

### Parameter cheat sheet

- `--repo owner/name` — limit watch to one repository; omit for all repos.
- `--interval seconds` — polling interval; default `300`.
- `--include-drafts` — include draft PRs; skipped by default.
- `--include-bots` — include bot authors like Dependabot; skipped by default.
- `--once` — single poll for testing; do not use for a long-running monitor.

After starting, tell the user: "Watching <scope> every <interval>; `/jobs` shows active monitors and `/cancel <jobID>` stops it."
````

- [ ] **Step 2: Ensure stop examples are explicit**

Update `## Stop watching` to include:

````md
## Stop watching

Run `/jobs`, find the `mon_*` job, then `/cancel <jobID>`.

```text
/jobs
/cancel mon_1
```
````

- [ ] **Step 3: Scan skill docs for private names/secrets**

```bash
rg -n "github.com/[^ ]+|https?://|token|secret|api_key|password|wdcas|casonatto|Shodocan" skills/github-pr-watch/SKILL.md
```

Expected: no tokens, private hostnames, or real private repo names; examples use `acme-org/example-service`.

- [ ] **Step 4: Commit Task 5**

```bash
git add skills/github-pr-watch/SKILL.md
git commit -m "docs: clarify GitHub PR watch examples"
```

---

### Task 6: Final validation and package smoke checks

**Parallel:** after Tasks 1–5
**Touches:** no planned source files unless fixing validation failures

**Files:**
- No planned source changes.

- [ ] **Step 1: Run typecheck**

```bash
npm run typecheck
```

Expected: exits `0`.

- [ ] **Step 2: Run full test suite**

```bash
npm test
```

Expected: all Vitest tests pass.

- [ ] **Step 3: Inspect package contents**

```bash
npm pack --dry-run
```

Expected: package includes `extensions`, `src`, `skills`, `README.md`, `LICENSE`; no generated context/research artifacts.

- [ ] **Step 4: Inspect git diff for whitespace and secrets**

```bash
git status --short
git diff --check
rg -n "token|secret|api_key|password|wdcas|casonatto" docs/plans/2026-06-18-monitor-visibility-hardening.md skills/github-pr-watch/SKILL.md README.md extensions src test || true
```

Expected: only intended files changed; `git diff --check` clean; no committed secrets/private names.

- [ ] **Step 5: Manual Pi smoke test**

```bash
pi -e .
```

Then in Pi:

```text
/monitor --regex '^NEVER_MATCH$' -- sh -c 'sleep 1; exit 0'
```

Expected:
- Footer/status shows one monitor while active.
- Widget shows `mon_*` active job.
- After one second, warning says monitor stopped and no longer watching.
- `/jobs` shows the monitor completed.

Then:

```text
/monitor --regex '^NEVER_MATCH$' -- sh -c 'echo boom >&2; sleep 1; exit 7'
```

Expected:
- Footer/status shows one monitor while active.
- After one second, error says monitor died and no longer watching.
- Delivered message includes `exit code 7` and capped recent output containing `boom`.
- `/jobs` shows the monitor failed.
