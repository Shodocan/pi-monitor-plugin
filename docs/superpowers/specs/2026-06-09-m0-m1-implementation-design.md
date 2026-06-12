# M0/M1 Implementation Design — pi-monitor-plugin

Date: 2026-06-09

## Scope

Implement only PLAN.md milestones M0 and M1.

- M0: host-agnostic engine under `src/`, with vitest coverage ported/adapted from the sibling `../opencode-monitor-plugin` checkout.
- M1: Pi extension wiring in `extensions/pi-monitor.ts` plus Pi-native delivery in `src/delivery.ts`.
- Stop after M1. Do not implement M2 UI widgets/status beyond minimal lifecycle status already required for M1. Do not implement M3 GitHub watcher polish, M4 packaging polish, or M5 publishing.

Locked decisions from PLAN.md §2, §3.1, §3.2, §3.3, §3.5, §6, and §7 remain authoritative.

## Approach Options

1. **Recommended: direct port + Pi-native adapters.** Port upstream host-agnostic logic (`ProcessRunner`, `MonitorEngine`, scheduler, parsers, formatter, limits, types) and adapt only registry/session ownership, ReDoS startup vetting, delivery caps, and Pi extension entrypoints.
   - Pros: follows PLAN.md; lowest behavior drift; leverages existing test material.
   - Cons: upstream assumptions must be carefully removed where bridge/MCP concepts leak into tests.
2. **Rewrite core modules from scratch.** Use PLAN.md as a behavioral spec and ignore upstream code.
   - Pros: clean Pi-centric code.
   - Cons: higher regression risk and slower; loses battle-tested process/regex window edge cases.
3. **Preserve upstream bridge-like abstractions behind Pi shims.** Keep more original structure while swapping the transport.
   - Pros: fastest mechanical copy.
   - Cons: violates the DROP table by retaining bridge-shaped complexity; harder to reason about lifecycle and caps.

Chosen approach: **Option 1**.

## Architecture

### Core modules (M0)

- `src/types.ts`: job kinds/states/records and delivery payload types without OpenCode-specific bridge statuses.
- `src/limits.ts`: PLAN.md §7 constants, excluding bridge-only constants.
- `src/registry.ts`: active/completed job registry with `bg_N` / `mon_N` / `loop_N` / `sched_N` IDs, max-active enforcement, completed retention, and session ownership stored in job records.
- `src/runner/process-runner.ts`: `/bin/sh -c` process spawning, detached process group, stdout/stderr tail buffers, SIGTERM-to-group then SIGKILL grace.
- `src/runner/monitor-engine.ts`: ring buffer, regex before/after windows, debounce, merge/dedupe, flush/destroy, and actual enforcement of 16 KiB / 200-event per-delivery caps.
- `src/runner/redos.ts`: one-time regex pattern vetting at monitor job start with 100 ms worker timeout and bounded concurrency.
- `src/scheduler.ts`: prompt loop and one-shot schedule timers; loop chaining avoids backlog.
- `src/parser/*`: slash grammars for background, monitor, loop, schedule, and durations.
- `src/delivery-format.ts`: nonce fencing, ANSI/control stripping, best-effort secret redaction, and delivery body formatting.

No module under `src/` may import Pi APIs except `src/delivery.ts` for M1.

### Pi wiring (M1)

- `extensions/pi-monitor.ts` owns session-local runtime state in factory-closure variables.
- `session_start`: create fresh `JobRegistry`, `ProcessRunner`, `PromptScheduler`, and `PiDelivery`; capture current session context only for the active session.
- `session_shutdown`: stop all active jobs, clear all timers, destroy monitor engines, clear delivery queues/coalesced loop entries, and drop stale context references.
- Commands and tools share handler functions:
  - `/background` and `jobs_background`
  - `/monitor` and `jobs_monitor`
  - `/loop` and `jobs_loop`
  - `/schedule` and `jobs_schedule`
  - `/jobs` and `jobs_list`
  - `/cancel` and `jobs_cancel`
- Tool schemas use `Type.*` from `typebox` and `StringEnum` from `@earendil-works/pi-ai` for `deliver` values.
- Tools return immediately (`started <jobID>` or list/cancel results); background work continues in closure state.

## Delivery Design

`src/delivery.ts` implements PLAN.md §3.2 exactly:

- Idle: `pi.sendMessage({ customType: "pi-monitor", content, display: true }, { triggerTurn: true })`.
- Busy + polite/default: `pi.sendMessage(..., { deliverAs: "nextTurn" })` and best-effort `ctx.ui.notify` when UI exists.
- Busy + interrupt/steer opt-in: `pi.sendMessage(..., { deliverAs: "steer" })`.
- Loop ticks while busy coalesce by job ID: keep the latest prompt, count skipped ticks, and annotate delivery with `[coalesced N loop ticks while session was busy]`.
- All delivered process output is nonce-fenced/sanitized/redacted before injection.

## Error Handling

- Parser errors return clear command/tool results without starting jobs.
- Job start fails before registry registration when ReDoS vetting rejects a monitor pattern.
- Process exits complete or fail the job based on exit code while still delivering capped tails.
- Cancellation kills active process groups or clears timers, then marks jobs cancelled.
- Delivery failures are caught and reflected in job state/result text where possible; they must not leave timers/processes orphaned.
- Lifecycle shutdown is best-effort and idempotent; no stale Pi context is reused after shutdown.

## Testing and Validation

Per module:

1. Port/adapt relevant upstream vitest suites alongside the module.
2. Run focused tests for the module.
3. Run `npm run typecheck && npm test` after each coherent unit.

Final acceptance:

- `npm run typecheck` passes.
- `npm test` passes.
- Manual Pi smoke checklist from PLAN.md §5 is attempted with `pi -e .`:
  - `/background sh -c "sleep 2; echo done"`
  - `/monitor --regex 'PI_SMOKE' -- sh -c "sleep 2; printf 'PI_SMOKE ok\n'"`
  - `/loop 15s say tick`
  - `/schedule in 1m say hello`
  - `/jobs && /cancel <id>`

If the environment prevents manual Pi smoke execution, report the exact blocker and keep the result unverified.

## Non-Goals

- No bridge/HTTP/MCP/status-store code.
- No build step.
- No runtime bundling of Pi-provided dependencies.
- No GitHub watcher redesign or native `/watch-prs` command.
- No M2 UI widget/status panel implementation beyond minimal safe status cleanup if needed.
- No M4 packaging or M5 publish work.

## Spec Self-Review

- Placeholder scan: no TBD/TODO placeholders.
- Consistency check: matches PLAN.md M0/M1 scope and DROP table.
- Scope check: focused on one implementation plan ending after M1.
- Ambiguity check: handler, delivery, lifecycle, validation, and non-goals are explicit.

Spec gate result: self-reviewed and auto-approved per the session's spec-gate override.
