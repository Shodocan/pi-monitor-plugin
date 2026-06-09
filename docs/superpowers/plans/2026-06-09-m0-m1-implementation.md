# M0/M1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement PLAN.md milestones M0 and M1 for `pi-monitor-plugin`, stopping before M2/M3.

**Architecture:** Port upstream host-agnostic OpenCode monitor modules into focused pure `src/` modules, then add a thin Pi-native delivery/extension layer. Drop bridge/HTTP/MCP/status-store code. Keep runtime state session-scoped and torn down on `session_shutdown`.

**Tech Stack:** TypeScript ESM loaded by Pi via jiti, TypeBox tool schemas, `@earendil-works/pi-ai` `StringEnum`, Node `child_process`/`worker_threads`, Vitest.

---

## Constraints

- Worktree: `/home/wdcas/projects/pessoal/pi-background-proccess-plugin/.worktrees/implement-m0-m1` on branch `implement-m0-m1`.
- Required source docs already read: `PLAN.md`, `AGENTS.md`, `docs/research/pi-api-reference.md`, `docs/research/oc-architecture.md`.
- Source to port: sibling checkout `/home/wdcas/projects/pessoal/opencode-monitor-plugin`.
- Keep explicit `.ts` relative imports.
- No build step. `npm run typecheck` is `tsc --noEmit` only.
- Do not import Pi APIs from M0 core modules. `src/delivery.ts` and `extensions/pi-monitor.ts` are the M1 Pi-facing layer.
- Use TypeBox schemas; use `StringEnum` for enum tool params.
- Do not add zod, RE2, bridge servers, HTTP notifiers, status stores, MCP contracts, or watcher-specific code.
- Before commits that add docs/fixtures, scan the diff for secrets and real host/repo names.
- For write-capable implementation tasks, use the `subagent-task-harness` skill: generate dispatch prompt, validate returned artifacts, then parent runs review/validation/commit.

## File Responsibility Map

- `src/types.ts`: job kinds/states/records, process output events, monitor window/delivery data shapes.
- `src/limits.ts`: PLAN.md §7 constants, excluding bridge-only constants.
- `src/registry.ts`: session-scoped active/completed job registry, retention, cancelable state transitions.
- `src/parser/*`: slash command grammars for background, monitor, loop, schedule, and duration/date helpers.
- `src/delivery-format.ts`: nonce fence, ANSI/control sanitization, redaction, delivery body/list/cancel formatting.
- `src/runner/process-runner.ts`: detached `/bin/sh -c` execution, tail buffers, output events, cancellation.
- `src/runner/monitor-engine.ts`: regex windows, before/after context, debounce, dedupe, per-delivery caps.
- `src/runner/redos.ts`: monitor regex startup vetting with worker timeout/concurrency.
- `src/scheduler.ts`: prompt loops and one-shot timers.
- `src/delivery.ts`: Pi-native idle/busy delivery and loop tick coalescing.
- `extensions/pi-monitor.ts`: lifecycle, command/tool registration, shared handlers, runtime cleanup.
- `test/*.test.ts`: ported/adapted Vitest suites by module.

## Task 1: Core Types, Limits, Registry

**Files:**
- Create: `src/types.ts`
- Create: `src/limits.ts`
- Create: `src/registry.ts`
- Create: `test/types.test.ts`
- Create: `test/registry.test.ts`

**Subagent dispatch prompt:**

```text
GOAL: Add M0 core domain types, limits, and session-scoped job registry with tests.
FILES:
- Create: src/types.ts
- Create: src/limits.ts
- Create: src/registry.ts
- Create: test/types.test.ts
- Create: test/registry.test.ts
INSTRUCTIONS:
1. Port/adapt from /home/wdcas/projects/pessoal/opencode-monitor-plugin/src/types.ts, src/limits.ts, and src/registry/job-registry.ts.
2. Drop bridge-specific delivery statuses/constants; keep PLAN.md §7 values and active/completed retention behavior.
3. Store session ownership directly in job records. IDs must be <kind>_<counter>.
4. Port/adapt tests from upstream test/types.test.ts and test/job-registry.test.ts.
CONSTRAINTS:
- Stay within the declared file touch set.
- No Pi imports, no bridge/HTTP/MCP/status-store concepts.
VALIDATION:
- npm test -- test/types.test.ts test/registry.test.ts
- npm run typecheck
- Expected: both commands pass.
STOP: DONE when validation passes; NEEDS_CONTEXT for ambiguity; BLOCKED for unsafe/missing validation.
```

- [ ] Run harness `generate-prompt` for Task 1.
- [ ] Dispatch one write-capable subagent with the generated prompt.
- [ ] Run harness `check-result` against the five declared files.
- [ ] Review diff for bridge leftovers and secret-sensitive strings.
- [ ] Validate:

```bash
npm test -- test/types.test.ts test/registry.test.ts && npm run typecheck
```

- [ ] Commit after validation:

```bash
git add src/types.ts src/limits.ts src/registry.ts test/types.test.ts test/registry.test.ts
git push
```

## Task 2: Basic Slash Parsers

**Files:**
- Create: `src/parser/time-utils.ts`
- Create: `src/parser/parse-background.ts`
- Create: `src/parser/parse-loop.ts`
- Create: `src/parser/parse-schedule.ts`
- Create: `test/parser-basic.test.ts`

**Subagent dispatch prompt:**

```text
GOAL: Add background, loop, schedule, and time parser modules with tests.
FILES:
- Create: src/parser/time-utils.ts
- Create: src/parser/parse-background.ts
- Create: src/parser/parse-loop.ts
- Create: src/parser/parse-schedule.ts
- Create: test/parser-basic.test.ts
INSTRUCTIONS:
1. Port/adapt from sibling src/parser/time-utils.ts, parse-background.ts, parse-loop.ts, parse-schedule.ts.
2. Preserve grammar and validation from PLAN.md and upstream tests: strip one quote layer for background; duration units s/m/h; loop minimum 10s; schedule at/in future and within 30 days; reject d unit for schedule in.
3. Import constants from ../limits.ts using explicit .ts extensions.
4. Port only matching parser cases from upstream test/parser.test.ts into test/parser-basic.test.ts.
CONSTRAINTS:
- Stay within the declared file touch set.
- No monitor parser in this task.
VALIDATION:
- npm test -- test/parser-basic.test.ts
- npm run typecheck
- Expected: both commands pass.
STOP: DONE when validation passes; NEEDS_CONTEXT for ambiguity; BLOCKED for unsafe/missing validation.
```

- [ ] Generate prompt, dispatch, check result, review diff.
- [ ] Validate:

```bash
npm test -- test/parser-basic.test.ts && npm run typecheck
```

- [ ] Commit:

```bash
git add src/parser/time-utils.ts src/parser/parse-background.ts src/parser/parse-loop.ts src/parser/parse-schedule.ts test/parser-basic.test.ts
git push
```

## Task 3: Monitor Parser and Parser Barrel

**Files:**
- Create: `src/parser/parse-monitor.ts`
- Create: `src/parser/index.ts`
- Create: `test/parser-monitor.test.ts`

**Subagent dispatch prompt:**

```text
GOAL: Add monitor slash parser and parser barrel exports with tests.
FILES:
- Create: src/parser/parse-monitor.ts
- Create: src/parser/index.ts
- Create: test/parser-monitor.test.ts
INSTRUCTIONS:
1. Port/adapt sibling src/parser/parse-monitor.ts and parser/index.ts.
2. Preserve last standalone -- split, --regex requirement, /pattern/flags parsing, quote stripping, 512-char cap, g/y flag rejection, before/after 0..200, debounce 1..60 seconds, defaults before=10 after=10 debounceMs=5000.
3. Export all parser functions from index.ts with explicit .ts extensions.
4. Port monitor-related parser cases from upstream test/parser.test.ts into test/parser-monitor.test.ts.
CONSTRAINTS:
- Stay within declared file touch set.
- Do not modify Task 2 parser files unless type errors require import-path fixes; stop first if that happens.
VALIDATION:
- npm test -- test/parser-basic.test.ts test/parser-monitor.test.ts
- npm run typecheck
- Expected: both commands pass.
STOP: DONE when validation passes; NEEDS_CONTEXT for ambiguity; BLOCKED for unsafe/missing validation.
```

- [ ] Generate prompt, dispatch, check result, review diff.
- [ ] Validate:

```bash
npm test -- test/parser-basic.test.ts test/parser-monitor.test.ts && npm run typecheck
```

- [ ] Commit:

```bash
git add src/parser/parse-monitor.ts src/parser/index.ts test/parser-monitor.test.ts
git push
```

## Task 4: Delivery Formatter

**Files:**
- Create: `src/delivery-format.ts`
- Create: `test/delivery-format.test.ts`

**Subagent dispatch prompt:**

```text
GOAL: Add nonce-fenced delivery formatting, sanitization, redaction, and formatting tests.
FILES:
- Create: src/delivery-format.ts
- Create: test/delivery-format.test.ts
INSTRUCTIONS:
1. Port/adapt sibling src/delivery/delivery-formatter.ts into src/delivery-format.ts.
2. Preserve generateNonce, sanitize, redactSecrets, formatDelivery, formatAutoSubmit-like behavior where still useful, formatJobs, and formatCancel.
3. Drop OpenCode bridge metadata naming where it is not relevant; keep job kind/status labels and nonce fence semantics.
4. Port/adapt upstream test/delivery-formatter.test.ts.
CONSTRAINTS:
- Stay within declared file touch set.
- Do not emit real tokens, endpoints, or real organization names in tests.
VALIDATION:
- npm test -- test/delivery-format.test.ts
- npm run typecheck
- Expected: both commands pass.
STOP: DONE when validation passes; NEEDS_CONTEXT for ambiguity; BLOCKED for unsafe/missing validation.
```

- [ ] Generate prompt, dispatch, check result, review diff and secret scan.
- [ ] Validate:

```bash
npm test -- test/delivery-format.test.ts && npm run typecheck
```

- [ ] Commit:

```bash
git add src/delivery-format.ts test/delivery-format.test.ts
git push
```

## Task 5: Process Runner

**Files:**
- Create: `src/runner/process-runner.ts`
- Create: `test/process-runner.test.ts`

**Subagent dispatch prompt:**

```text
GOAL: Add detached shell process runner with capped tails and cancellation tests.
FILES:
- Create: src/runner/process-runner.ts
- Create: test/process-runner.test.ts
INSTRUCTIONS:
1. Port sibling src/runner/process-runner.ts and upstream test/process-runner.test.ts.
2. Preserve spawn('/bin/sh', ['-c', command], { detached: true, stdio: ['ignore','pipe','pipe'], shell: false }), close-event exit promise, stdout/stderr output events, per-stream tail cap 200 lines/32 KiB, duplicate job rejection, SIGTERM group cancel then SIGKILL after PLAN.md grace.
3. Import constants/types from ../limits.ts and ../types.ts with explicit .ts extensions.
CONSTRAINTS:
- Stay within declared file touch set.
- Do not add broad shell abstractions or external dependencies.
VALIDATION:
- npm test -- test/process-runner.test.ts
- npm run typecheck
- Expected: both commands pass.
STOP: DONE when validation passes; NEEDS_CONTEXT for ambiguity; BLOCKED for unsafe/missing validation.
```

- [ ] Generate prompt, dispatch, check result, review diff for shell-safety invariants.
- [ ] Validate:

```bash
npm test -- test/process-runner.test.ts && npm run typecheck
```

- [ ] Commit:

```bash
git add src/runner/process-runner.ts test/process-runner.test.ts
git push
```

## Task 6: Monitor Engine with Delivery Caps

**Files:**
- Create: `src/runner/monitor-engine.ts`
- Create: `test/monitor-engine.test.ts`

**Subagent dispatch prompt:**

```text
GOAL: Add monitor regex window engine and enforce per-delivery caps.
FILES:
- Create: src/runner/monitor-engine.ts
- Create: test/monitor-engine.test.ts
INSTRUCTIONS:
1. Port sibling src/runner/monitor-engine.ts and upstream test/monitor-engine.test.ts.
2. Preserve ring buffer, before/after context, after wait timeout, debounce, merge/dedupe, flush, destroy, and delivered sequence pruning.
3. Actually enforce PLAN.md per-delivery caps: emitted windows must include at most MONITOR_PER_DELIVERY_CAP_EVENTS events and at most MONITOR_PER_DELIVERY_CAP_BYTES worth of line content/metadata. Add explicit tests for both caps.
4. Keep regex matching synchronous here; ReDoS startup vetting is added in Task 7 and wired at job start in M1.
CONSTRAINTS:
- Stay within declared file touch set.
- No Pi imports.
VALIDATION:
- npm test -- test/monitor-engine.test.ts
- npm run typecheck
- Expected: both commands pass, including new cap tests.
STOP: DONE when validation passes; NEEDS_CONTEXT for ambiguity; BLOCKED for unsafe/missing validation.
```

- [ ] Generate prompt, dispatch, check result, review diff for cap enforcement.
- [ ] Validate:

```bash
npm test -- test/monitor-engine.test.ts && npm run typecheck
```

- [ ] Commit:

```bash
git add src/runner/monitor-engine.ts test/monitor-engine.test.ts
git push
```

## Task 7: ReDoS Pattern Vetting

**Files:**
- Create: `src/runner/redos.ts`
- Create: `test/redos.test.ts`

**Subagent dispatch prompt:**

```text
GOAL: Add ReDoS pattern vetting for monitor job startup.
FILES:
- Create: src/runner/redos.ts
- Create: test/redos.test.ts
INSTRUCTIONS:
1. Adapt sibling src/runner/redos-worker.ts and redos-thread.ts into one public src/runner/redos.ts module.
2. Export a timeout error and async vetRegexPattern(pattern, flags?) API suitable for M1 job start.
3. Enforce PLAN.md values: 100 ms timeout and 4 concurrent workers. Reject invalid regexes and patterns that time out on pathological input.
4. Port/adapt upstream test/redos-worker.test.ts into test/redos.test.ts.
CONSTRAINTS:
- Stay within declared file touch set.
- No external regex dependencies.
VALIDATION:
- npm test -- test/redos.test.ts
- npm run typecheck
- Expected: both commands pass.
STOP: DONE when validation passes; NEEDS_CONTEXT for ambiguity; BLOCKED for unsafe/missing validation.
```

- [ ] Generate prompt, dispatch, check result, review diff for worker cleanup/timeouts.
- [ ] Validate:

```bash
npm test -- test/redos.test.ts && npm run typecheck
```

- [ ] Commit:

```bash
git add src/runner/redos.ts test/redos.test.ts
git push
```

## Task 8: Prompt Scheduler

**Files:**
- Create: `src/scheduler.ts`
- Create: `test/scheduler.test.ts`

**Subagent dispatch prompt:**

```text
GOAL: Add prompt loop and one-shot scheduler with tests.
FILES:
- Create: src/scheduler.ts
- Create: test/scheduler.test.ts
INSTRUCTIONS:
1. Port sibling src/scheduler/prompt-scheduler.ts into src/scheduler.ts.
2. Preserve immediate first loop tick, chained no-backlog loop scheduling, delivery error swallowing, one-shot timers, and cancel/destroy behavior.
3. Port/adapt upstream test/prompt-scheduler.test.ts into test/scheduler.test.ts.
CONSTRAINTS:
- Stay within declared file touch set.
- No Pi imports.
VALIDATION:
- npm test -- test/scheduler.test.ts
- npm run typecheck
- Expected: both commands pass.
STOP: DONE when validation passes; NEEDS_CONTEXT for ambiguity; BLOCKED for unsafe/missing validation.
```

- [ ] Generate prompt, dispatch, check result, review diff.
- [ ] Validate:

```bash
npm test -- test/scheduler.test.ts && npm run typecheck
```

- [ ] Commit:

```bash
git add src/scheduler.ts test/scheduler.test.ts
git push
```

## Task 9: Pi-Native Delivery

**Files:**
- Create: `src/delivery.ts`
- Create: `test/delivery.test.ts`

**Subagent dispatch prompt:**

```text
GOAL: Add Pi-native idle/busy delivery and loop coalescing.
FILES:
- Create: src/delivery.ts
- Create: test/delivery.test.ts
INSTRUCTIONS:
1. Implement PLAN.md §3.2 exactly: idle sendMessage customType pi-monitor with triggerTurn true; busy polite/default uses deliverAs nextTurn and UI toast; busy interrupt uses deliverAs steer.
2. Implement loop tick coalescing by job ID while busy: keep latest prompt, count skipped ticks, annotate [coalesced N loop ticks while session was busy] when delivered.
3. Use src/delivery-format.ts for nonce-fenced process output formatting; raw loop/schedule prompts must not be nonce-wrapped unless they include process output.
4. Unit-test with mocked pi and ctx objects; do not require a real Pi session.
CONSTRAINTS:
- Stay within declared file touch set.
- This is the only src/ M1 module allowed to depend on Pi-like sendMessage semantics.
VALIDATION:
- npm test -- test/delivery.test.ts
- npm run typecheck
- Expected: both commands pass.
STOP: DONE when validation passes; NEEDS_CONTEXT for ambiguity; BLOCKED for unsafe/missing validation.
```

- [ ] Generate prompt, dispatch, check result, review diff for PLAN.md §3.2 compliance.
- [ ] Validate:

```bash
npm test -- test/delivery.test.ts && npm run typecheck
```

- [ ] Commit:

```bash
git add src/delivery.ts test/delivery.test.ts
git push
```

## Task 10: Extension Background and Monitor Handlers

**Files:**
- Modify: `extensions/pi-monitor.ts`
- Create: `test/pi-monitor-background-monitor.test.ts`

**Subagent dispatch prompt:**

```text
GOAL: Replace scaffold for background and monitor with real shared command/tool handlers.
FILES:
- Modify: extensions/pi-monitor.ts
- Create: test/pi-monitor-background-monitor.test.ts
INSTRUCTIONS:
1. In extensions/pi-monitor.ts, create session-local runtime state in factory closure and initialize it in session_start: JobRegistry, ProcessRunner, monitor engine map, delivery adapter, cleanup disposers.
2. Implement /background and jobs_background using parseBackground, JobRegistry, ProcessRunner, formatDelivery, and PiDelivery. Return/notify started <jobID> immediately and deliver capped stdout/stderr tail on exit.
3. Implement /monitor and jobs_monitor using structured TypeBox params, parseMonitor for slash command input, ReDoS vetting at job start, ProcessRunner output events, MonitorEngine windows, and PiDelivery.
4. Keep loop/schedule/jobs/cancel commands functional as explicit not-yet-implemented stubs only until Task 11; do not register their tools yet if incomplete.
5. Test command/tool registration and mocked background/monitor start paths without a real Pi session.
CONSTRAINTS:
- Stay within declared file touch set.
- No bridge/HTTP/MCP/status-store code.
VALIDATION:
- npm test -- test/pi-monitor-background-monitor.test.ts
- npm run typecheck
- Expected: both commands pass.
STOP: DONE when validation passes; NEEDS_CONTEXT for ambiguity; BLOCKED for unsafe/missing validation.
```

- [ ] Generate prompt, dispatch, check result, review diff for lifecycle/session-state discipline.
- [ ] Validate:

```bash
npm test -- test/pi-monitor-background-monitor.test.ts && npm run typecheck
```

- [ ] Commit:

```bash
git add extensions/pi-monitor.ts test/pi-monitor-background-monitor.test.ts
git push
```

## Task 11: Extension Loop, Schedule, List, Cancel, Tool Schemas

**Files:**
- Modify: `extensions/pi-monitor.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `test/pi-monitor-loop-schedule.test.ts`

**Subagent dispatch prompt:**

```text
GOAL: Finish M1 extension wiring for all six commands/tools and lifecycle cleanup.
FILES:
- Modify: extensions/pi-monitor.ts
- Modify: package.json
- Modify: package-lock.json
- Create: test/pi-monitor-loop-schedule.test.ts
INSTRUCTIONS:
1. Register all six jobs_* tools with TypeBox params per PLAN.md §3.3; use StringEnum from @earendil-works/pi-ai for deliver enum and add @earendil-works/pi-ai as a peerDependency "*" if absent.
2. Implement /loop and jobs_loop with PromptScheduler and PiDelivery coalescing. First tick fires immediately; no backlog.
3. Implement /schedule and jobs_schedule with at/in validation, PromptScheduler one-shot, completion on delivery.
4. Implement /jobs and jobs_list using formatJobs; implement /cancel and jobs_cancel to cancel process/monitor/scheduler resources, mark registry cancelled, clear timers, and return a concise result.
5. Ensure session_shutdown kills all active jobs, destroys monitor engines, clears scheduler timers, clears delivery coalescing, and drops stale context references.
6. Test registration of all commands/tools, loop/schedule/list/cancel happy paths, and shutdown cleanup with mocks.
CONSTRAINTS:
- Stay within declared file touch set.
- Do not implement M2 UI widgets or M3 watcher sugar.
VALIDATION:
- npm test -- test/pi-monitor-background-monitor.test.ts test/pi-monitor-loop-schedule.test.ts
- npm run typecheck
- Expected: both commands pass.
STOP: DONE when validation passes; NEEDS_CONTEXT for ambiguity; BLOCKED for unsafe/missing validation.
```

- [ ] Generate prompt, dispatch, check result, review diff for TypeBox/StringEnum/package peer rules.
- [ ] Validate:

```bash
npm test -- test/pi-monitor-background-monitor.test.ts test/pi-monitor-loop-schedule.test.ts && npm run typecheck
```

- [ ] Commit:

```bash
git add extensions/pi-monitor.ts package.json package-lock.json test/pi-monitor-loop-schedule.test.ts
git push
```

## Task 12: Final M0/M1 Validation, Deviations, PR

**Files:**
- Modify if needed: `PLAN.md`

**Subagent dispatch prompt:**

```text
GOAL: Run final validation for M0/M1 and record any actual deviations.
FILES:
- Modify if needed: PLAN.md
INSTRUCTIONS:
1. Run npm run typecheck && npm test.
2. Attempt manual smoke per PLAN.md §5 with pi -e . if the environment can run interactive pi; otherwise capture the exact blocker.
3. If implementation deviated from PLAN.md, append a new "Deviations" section at the bottom of PLAN.md with the deviation and reason. If there were no deviations, do not modify PLAN.md.
4. Do not start M2/M3/M4/M5.
CONSTRAINTS:
- Stay within declared file touch set.
- No code changes except PLAN.md deviation notes if required.
VALIDATION:
- npm run typecheck && npm test
- Manual smoke attempted or blocker documented.
- Expected: automated validation passes; manual smoke status is explicit.
STOP: DONE when validation passes; NEEDS_CONTEXT for ambiguity; BLOCKED for unsafe/missing validation.
```

- [ ] Run final validation:

```bash
npm run typecheck && npm test
```

- [ ] Attempt manual smoke:

```bash
pi -e .
```

Then run the PLAN.md §5 slash commands in the real Pi session.

- [ ] If PLAN.md was updated with deviations, validate and commit:

```bash
git add PLAN.md
git push
```

- [ ] Request code review using the required review skill.
- [ ] Create PR from `implement-m0-m1` to `main` after review fixes and validation.
- [ ] Invoke PR monitor immediately after PR creation.

## Plan Self-Review

- Spec coverage: M0 modules, M1 delivery, commands/tools, lifecycle, tests, caps, ReDoS vetting, validation, and stop-after-M1 are each assigned to tasks.
- Placeholder scan: no TBD/TODO/"fill later" placeholders.
- Type consistency: module/file names match PLAN.md and the design doc.
- Task budget: each write-capable task declares at most five touched files except Task 11, which touches four files and is the final M1 integration step.
- Known baseline: before Task 1, `npm run typecheck` passed and `npm test` failed because the scaffold had no test files. Task 1 introduces the first tests.

Execution mode: subagent-driven development is selected by policy and user request; do not ask for a separate execution choice.
