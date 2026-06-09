# opencode-monitor-plugin — Architecture Report (for Pi extension re-architecture)

Source root: `<sibling>/opencode-monitor-plugin` (referred to as `src/...` below). All line numbers from current working tree.

---

## 1. Job Model

### 1.1 Job kinds

`JobKind = 'bg' | 'mon' | 'loop' | 'sched'` — `src/types.ts:1`. User-facing labels: background / monitor / loop / schedule (`src/delivery/delivery-formatter.ts:100-106`).

### 1.2 Lifecycle states

`JobState = 'active' | 'completed' | 'failed' | 'cancelled'` — `src/types.ts:2`. Orthogonal delivery state: `DeliveryStatus = 'pending' | 'sent' | 'bridge_failed' | 'unknown'` — `src/types.ts:3`.

Transitions live in `JobRegistry` (`src/registry/job-registry.ts`):
- `register(kind)` → `active`, throws `max active jobs (20)` at cap (`job-registry.ts:62-82`)
- `complete(jobID)` → `completed`, moved active→completed list (`job-registry.ts:128-135`)
- `fail(jobID, deliveryStatus?, queueDroppedCount?)` → `failed` (`job-registry.ts:140-149`); the plugin uses `fail(jobID, 'bridge_failed')` when delivery fails (`src/index.ts:177-184`)
- `cancel(jobID)` → `cancelled`; only active jobs cancellable, otherwise throws `job {id} cannot be cancelled (status: ...)` (`job-registry.ts:109-123`)
- `updateDeliveryStatus` / `incrementQueueDropped` mutate active *or* completed entries (`job-registry.ts:156-175`)
- Completed/failed/cancelled entries retained in a FIFO list trimmed to `MAX_COMPLETED_RETENTION` (`job-registry.ts:197-201`)

For `sched` jobs, the job is completed on successful delivery (`src/index.ts:156-160`); `bg`/`mon` complete on process exit (`src/index.ts:203`, `283`); `loop` only ends via cancel.

### 1.3 ID scheme

`jobID = "<kind>_<counter>"` from a per-registry monotonic counter (`job-registry.ts:67-68`), e.g. `bg_1`, `mon_2`, `loop_3`, `sched_4`. There is also a `sessionRef` = djb2-ish 32-bit hash of the registry's constructor sessionID, base36 (`job-registry.ts:13-19`); note the registry is constructed once with the literal string `'plugin'` (`src/index.ts:121`), so `sessionRef` is effectively constant and vestigial.

### 1.4 Ownership / session scoping

Real session ownership lives in the plugin's `runtimes` map: `jobID → { sessionID, kind, dispose }` (`src/index.ts:98-102, 126, 171-175`). `jobs` filters by `runtimes.get(job.jobID)?.sessionID === sessionID` (`src/index.ts:335-339`); `cancel` rejects cross-session cancels with `job {id} belongs to another session` (`src/index.ts:345-348`). `requireDirectUserContext` enforces `sessionID` presence and `invocationOrigin === 'user'` (`src/plugin-context.ts:10-16`) — though tool execution synthesizes a context with `invocationOrigin: 'user'` unconditionally (`src/index.ts:561-563`), so the model calling the tool counts as "user".

### 1.5 Caps and limits — exact values (`src/limits.ts`)

| Constant | Value | Line |
|---|---|---|
| `MAX_ACTIVE_JOBS` | `20` | limits.ts:2 |
| `MAX_COMPLETED_RETENTION` | `50` | limits.ts:3 |
| `PROCESS_OUTPUT_CAP_LINES` | `200` | limits.ts:6 |
| `PROCESS_OUTPUT_CAP_BYTES` | `32 * 1024` (32 KiB) | limits.ts:7 |
| `MONITOR_RING_BUFFER_EVENTS` | `50_000` | limits.ts:10 |
| `MONITOR_AFTER_WAIT_MS` | `5_000` | limits.ts:11 |
| `MONITOR_DEBOUNCE_DEFAULT_MS` | `5_000` | limits.ts:12 |
| `MONITOR_PER_DELIVERY_CAP_BYTES` | `16 * 1024` | limits.ts:13 |
| `MONITOR_PER_DELIVERY_CAP_EVENTS` | `200` | limits.ts:14 |
| `MAX_MONITOR_CONTEXT_LINES` | `200` | limits.ts:15 |
| `MAX_LINE_LENGTH` | `8 * 1024` | limits.ts:16 |
| `MAX_REGEX_PATTERN_LENGTH` | `512` | limits.ts:19 |
| `MIN_MONITOR_DEBOUNCE_S` / `MAX_MONITOR_DEBOUNCE_S` | `1` / `60` | limits.ts:22-23 |
| `MIN_LOOP_INTERVAL_MS` | `10_000` | limits.ts:26 |
| `MAX_SCHEDULE_HORIZON_MS` | `30 * 24 * 60 * 60 * 1000` (30 days) | limits.ts:29 |
| `MAX_PENDING_PER_JOB` | `20` | limits.ts:32 |
| `MAX_PENDING_GLOBAL` | `100` | limits.ts:33 |
| `MAX_QUEUE_BYTES_TOTAL` | `1024 * 1024` (1 MiB) | limits.ts:34 |
| `BRIDGE_UNAVAILABLE_EXPIRY_MS` | `10 * 60 * 1000` (10 min) | limits.ts:37 |
| `REDOS_TIMEOUT_MS` | `100` | limits.ts:40 |
| `REDOS_MAX_CONCURRENT` | `4` | limits.ts:41 |
| `REDOS_MAX_QUEUED_PER_MONITOR` | `10` | limits.ts:42 |
| `CANCEL_SIGKILL_TIMEOUT_MS` | `5_000` | limits.ts:45 |

Note: `MONITOR_PER_DELIVERY_CAP_BYTES`, `MONITOR_PER_DELIVERY_CAP_EVENTS`, and `MAX_LINE_LENGTH` are declared but not referenced anywhere in `src/` (only `MONITOR_AFTER_WAIT_MS`/`MONITOR_RING_BUFFER_EVENTS` are imported by the engine, `monitor-engine.ts:1`); they are spec intent not yet enforced.

---

## 2. The Four Job Types End-to-End

### 2.1 `/background <command>`

1. **Parse**: `parseBackground` trims and strips one layer of matching outer quotes; rejects empty (`src/parser/parse-background.ts:2-16`).
2. **Spawn**: handler at `src/index.ts:187-225` — bridge health check, `registry.register('bg')`, runtime registered with `dispose = runner.cancel(jobID)`, then `runner.run(jobID, command)` which spawns `/bin/sh -c <command>` with `detached: true`, `stdio: ['ignore','pipe','pipe']` (`src/runner/process-runner.ts:96-100`). Returns `started bg_N` immediately.
3. **Watch**: `ProcessRunner` keeps per-stream rolling `TailBuffer`s capped at 200 lines / 32 KiB each (`process-runner.ts:177-180`, `46-54`). The exit promise is created *before* listeners attach and resolves on `close` (so stdio is fully flushed) (`process-runner.ts:104-111`).
4. **Deliver**: on exit, body is `background <jobID> exited with code <code>` + `[stdout]`/`[stderr]` tail lines (`src/index.ts:114-118`), nonce-fenced via `formatDelivery`, sent through `deliver(...)` with `submit: true`, job completed, runner disposed (`src/index.ts:198-216`).

### 2.2 `/monitor --regex <pat> [--before N] [--after N] [--debounce S] -- <command>`

**Parse grammar** (`src/parser/parse-monitor.ts`):
- The *last* standalone `--` token (space-delimited or string-boundary) splits flags from command (`parse-monitor.ts:8-27`); missing separator or empty command throws (`:86-89`).
- Flags segment split on `--`; recognized prefixes `regex `, `before `, `after `, `debounce ` (`:98-126`). Unknown segments are silently ignored.
- `--regex` accepts bare pattern or `/pattern/flags` form with backslash-escape-aware closing-slash scan (`:48-69`), optional outer quotes stripped (`:39-46`); pattern length capped at 512; flags `g` and `y` rejected (`:71-76`).
- Validation: `before`/`after` ∈ `0..200`; `debounce` ∈ `1..60` seconds. Defaults: `before=10`, `after=10`, `debounce=5` s → `debounceMs=5000` (`:129-136`). `--regex` is required (`:128`).

**Engine** (`src/runner/monitor-engine.ts`) — wired in `src/index.ts:227-297`: runner `output` events feed `engine.ingest`, filtered by jobID; out-of-order/duplicate seqs dropped via `#highestSeenSeq` (`monitor-engine.ts:64-70`).

Regex window logic:
- Every event appends to a ring buffer of `MONITOR_RING_BUFFER_EVENTS = 50_000` events; overflow increments `#droppedFromRing` (`:133-139`).
- Every event also extends all *pending* windows still waiting for after-context (`#appendToPendingAfterWindows`, `:141-152`).
- On regex match (`regex.lastIndex` reset first, `:75-76`): build `PendingWindow` = last `before` ring events (excluding the match itself, `:78-80`) + the match event; `truncated` flagged when the ring couldn't supply the full requested before-context (`:81-82`).
- If `after === 0` the window is immediately ready; otherwise a per-window **after-wait timeout** of `MONITOR_AFTER_WAIT_MS = 5000 ms` fires it ready even if too few after-lines arrived (`:91-103`).
- Ready windows are **debounced**: a single trailing-edge timer of `debounceMs` (re-armed on each new ready window, `:169-179`); `debounceMs === 0` emits immediately.
- On emit, all ready windows are **merged**: union events by seq, dedup against `#deliveredSeqs` (so overlapping windows never re-deliver a line), matchSeqs sorted, OR of truncated flags (`:181-213`). Delivered-seq set is pruned below the min seq still protected by ring/pending/ready (`:215-229`).
- `flush()` on process exit force-readies all pending and emits (`:106-117`); `destroy()` clears timers (`:119-131`).

**Deliver**: window → `monitor <jobID> matched seq(s): ...` + optional `... (earlier lines omitted)` + `[stream] line` rows (`src/index.ts:104-112`), nonce-fenced, auto-submitted. Process exit → `engine.flush()`, complete, cleanup (`src/index.ts:280-288`).

### 2.3 `/loop <interval> <prompt>`

- **Parse**: `^(\S+)\s+(.+)$` with `s` flag; interval via `parseDuration` (`^(\d+)([a-z])$`, units `s|m|h` only — `src/parser/time-utils.ts:1-10`); enforces `intervalMs >= 10_000` (`src/parser/parse-loop.ts:4-17`).
- **Run**: `PromptScheduler.scheduleLoop` fires the first tick **immediately**, then chains the next `setTimeout(intervalMs)` only after the delivery callback settles — no backlog, one in-flight tick, delivery errors swallowed (`src/scheduler/prompt-scheduler.ts:43-48, 118-145`).
- **Deliver**: the raw prompt text is sent as-is (loop/sched skip `formatAutoSubmit` wrapping — `src/index.ts:148-151`). **Loop coalescing** happens in the `IdleQueue`: loop entries use a stable key `sessionID::jobID`, and while the session is busy each new tick *replaces* the pending entry and bumps `coalescedTickCount` (`src/bridge/idle-queue.ts:250-283`). On delivery, coalesced entries get the suffix `\n\n[coalesced N loop ticks while session was busy]` (`idle-queue.ts:365-372`). Coalesced entries are exempt from FIFO eviction (`idle-queue.ts:324-329`).

### 2.4 `/schedule in <duration> <prompt>` | `/schedule at <iso-date> <prompt>`

- **Grammar** (`src/parser/parse-schedule.ts`): first word must be `in` or `at` (`:7-13`).
  - `in`: `^(\d+)([a-z])\s+(.*)` — unit `d` explicitly rejected (`not d — use s, m, or h`, `:21`), zero duration rejected (`:24`), 30-day horizon enforced (`:27-28`).
  - `at`: ISO-8601 regex `^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?(?:Z|[+-]\d{2}:\d{2})?)\s+(.*)` (`:35-37`); must be strictly future and within 30 days (`:41-45`).
- **Run**: `scheduleOnce` sets one `setTimeout(max(0, runAt - now))` (`prompt-scheduler.ts:54-77`).
- **Deliver**: prompt sent raw with `submit: true`; on successful delivery the job is marked completed and runtime removed (`src/index.ts:156-160`).

---

## 3. Delivery Pipeline

### 3.1 Flow

Job event → `deliver()` (`src/index.ts:148-161`) → `notify` →
- **In real plugin mode**: `bridge.notify(request)` (`src/index.ts:461`) which enqueues into the in-process `IdleQueue` (`src/bridge/server.ts:249-260`).
- **Default/standalone mode**: `appendSubmitToSession` does an HTTP `POST {bridgeUrl}/notify/append-submit` with `authorization: Bearer <token>` (`src/delivery/notifier.ts:4-17`); `health()` GETs `/health` and asserts `{ok: true}` (`notifier.ts:19-28`). Every job-start handler calls `ensureBridgeAvailable()` first (`src/index.ts:167-169, 192, 242, 303, 321`).

### 3.2 Idle/busy queueing (`src/bridge/idle-queue.ts`)

- Per-session status cache `Map<sessionID, 'idle'|'busy'|'retry'>` (`idle-queue.ts:65`); unknown status treated as not-idle (`isIdle`, `:24-26`).
- `deliver(req)` always enqueues, then flushes only if that session is `idle` (`:155-165`). `setSessionStatus` flushes that session's queue on busy→idle transitions (`:133-144`).
- Targeted flush walks `#globalOrder` delivering only entries for the idle session; a `false`/throwing `onDelivery` stops the flush, retaining the tail (`:171-217`); reentrancy guarded by `#flushing` (`:169-172`).
- Caps: global count `MAX_PENDING_GLOBAL = 100` and byte cap `MAX_QUEUE_BYTES_TOTAL = 1 MiB` evict the oldest non-coalesced entry FIFO (`:301-339`); per-job cap `MAX_PENDING_PER_JOB = 20` evicts the oldest entry for that job (`:285-299, 344-359`). Eviction increments `dropped`.
- Session status is fed by OpenCode events `session.status` / `session.idle` (`src/index.ts:469-485`), plus a hack: each tool execute sets the session `busy`, then a 1.5 s `armIdleFallback` timer flips it back `idle` because the real event stream is unreliable mid-tool-call (`src/index.ts:431-436, 498-503`).
- A separate `DeliveryQueue` with 10-min TTL exists for bridge-unavailable buffering (`src/delivery/delivery-queue.ts:24-130`, `BRIDGE_UNAVAILABLE_EXPIRY_MS` at `limits.ts:37`) — **built and tested but not wired into `src/index.ts`** (no imports outside its own file/tests).

### 3.3 HTTP bridge + bearer token (`src/bridge/server.ts`)

- Loopback-only HTTP server (`127.0.0.1` or `::1` enforced, `:197-200`, `:62-68`), random port, two routes: `GET /health`, `POST /notify/append-submit` (`:262-277`). Request bodies capped at 1 MiB (`:131-144`).
- Bearer token: 32 random bytes base64url (`:43-45`); validation requires ≥43 chars, charset `[A-Za-z0-9_-]`, and rejects a denylist `{'default','example','example-token','changeme','change-me','token'}` (`:47-60`). Auth comparison is length-checked + `crypto.timingSafeEqual` (`:306-315`).
- Config handshake file `{url, token}` written to `$XDG_RUNTIME_DIR|tmpdir()/opencode-monitor/bridge.json` (env override `OPENCODE_MONITOR_BRIDGE_CONFIG`, `:32-41`) with paranoid FS hygiene: dir `0700`, file `0600`, symlink rejection on parent and file, uid ownership check on read (`:70-124`).
- Accepted POST bodies are strictly validated `AutoSubmitRequest` shapes (`submit` must be literal `true`, kind in `bg|mon|loop|sched`, `:150-169`); unregistered sessions → 409 (`:297-300`).
- Delivered requests are converted to a `PromptSyntheticNotification` (`method: 'notifications/opencode/prompt/synthetic'`, `:171-180`) and pushed to OpenCode via `client.session.promptAsync` or raw `POST {serverUrl}/session/:id/prompt_async` with `parts: [{type:'text', synthetic: true, metadata:{...}}]` (`src/index.ts:378-422`). The full custom MCP notification contract (synthetic prompts, session status, toasts, command execute) is documented in `docs/opencode-custom-contract.md:46-398`.

### 3.4 Nonce framing, sanitization, redaction (`src/delivery/delivery-formatter.ts`)

- **Nonce framing**: `generateNonce()` = 16 random bytes hex (32 chars) (`:7-9`). `formatDelivery` produces `nonce \n "monitor triggered." \n <content> \n nonce` (`:129-148`) — untrusted process output is fenced so the model can distinguish injected instructions in output from the directive. `formatAutoSubmit` unwraps already-fenced text (`NONCE_RE = /^[0-9a-f]{32}$/`, `:50`; `unwrapNonceFence`, `:86-93`) to avoid nested fences and merges metadata `[kind] job=<jobID>` inside one fence (`:157-171`).
- **ANSI/control sanitization**: strips OSC (`/\x1b\][^\x07]*\x07/g`), CSI (`/\x1b\[[0-9;]*[a-zA-Z]/g`), `\r`, and all remaining control chars except `\n`/`\t` (`:19-38`).
- **Secret redaction** (best-effort, `:44-71`): key/value patterns for `TOKEN|ACCESS_TOKEN|BEARER_TOKEN|PRIVATE_KEY|API_KEY|SECRET|PASSWORD` with `:`/`=` separators and quote preservation → `****`; `Authorization Bearer <token>` → `Authorization Bearer ****`; URL userinfo `scheme://user:pass@` → `scheme://****@`.
- Previews truncated to `DEFAULT_MAX_PREVIEW = 200` chars with `…` (`:4, 77-80`).

### 3.5 What exists ONLY because OpenCode plugins are out-of-process / lack message injection

These exist solely to smuggle text back into a session the plugin can't directly write to. **A Pi extension runs in-process and can inject messages/steer directly, so all of the following are droppable:**

- The entire **HTTP bridge server** — listener, routes, port allocation (`src/bridge/server.ts:182-316`).
- **Bearer token generation/validation/timing-safe compare** (`server.ts:43-60, 306-315`) and the **bridge config file handshake** with its permission/symlink/uid checks (`server.ts:70-124`).
- The **HTTP notifier client** + `/health` preflight (`src/delivery/notifier.ts` entirely; `ensureBridgeAvailable` at `src/index.ts:167-169`).
- The **`DeliveryQueue`** bridge-unavailable TTL buffer (`src/delivery/delivery-queue.ts`) and `deliveryStatus: 'bridge_failed'` state.
- The **synthetic-prompt MCP notification contract** and `promptAsync`/`prompt_async` HTTP fallback (`src/index.ts:378-422`; `docs/opencode-custom-contract.md:251-292`).
- The **idle-detection hacks**: `session.status`/`session.idle` event plumbing (`src/index.ts:469-485`) and the 1.5 s `armIdleFallback` busy→idle timer (`src/index.ts:431-436`). Pi has first-class knowledge of agent turn state.
- The **file-based status store** for cross-process TUI communication (`src/status-store.ts` — atomic tmp+rename JSON at `$XDG_RUNTIME_DIR/opencode-monitor/status/<sha256-of-cwd-prefix16>.json`, `:32-45`) — only needed because the TUI plugin runs in a different process from the server plugin.
- The **slash-command→prompt-template→tool indirection** (see §6) — needed because OpenCode plugin commands can't run code directly.

What is *conceptually* worth keeping even in-process: the **idle-gated delivery + loop coalescing semantics** of `IdleQueue` (don't interrupt a busy turn; coalesce loop ticks) — but reimplemented against Pi's native turn lifecycle rather than event-sniffed session status.

---

## 4. Safety Engineering Worth Porting

- **ReDoS validation in worker threads** (`src/runner/redos-worker.ts`, `redos-thread.ts`): each regex test runs in a disposable `worker_threads.Worker` that gets `terminate()`d after `REDOS_TIMEOUT_MS = 100 ms`; pool capped at `REDOS_MAX_CONCURRENT = 4` with a per-monitor queue cap of `10` and queue-side timeouts (`redos-worker.ts:54-180`); the thread itself just compiles and `test()`s (`redos-thread.ts:15-26`). **Important caveat: this component is tested but NOT wired into the live path** — `MonitorEngine.ingest` runs `this.opts.regex.test(event.line)` synchronously on the main thread (`monitor-engine.ts:75-76`); the only live mitigations are the 512-char pattern cap and `g`/`y` flag rejection at parse time (`parse-monitor.ts:62-76`). A Pi port should either wire it in (e.g., one-time pattern vetting against pathological inputs at job start) or use RE2/regex timeouts.
- **Output caps**: per-stream rolling tails of 200 lines / 32 KiB (`process-runner.ts:177-180`); 50k-event monitor ring (`monitor-engine.ts:60`); idle-queue global/per-job/byte caps (§3.2); HTTP body cap of 1 MiB (`server.ts:137-139`); declared-but-unwired per-delivery caps of 16 KiB / 200 events (`limits.ts:13-14`) that a port should actually enforce.
- **Shell execution model**: `spawn('/bin/sh', ['-c', command], { detached: true, stdio: ['ignore','pipe','pipe'], shell: false })` (`process-runner.ts:96-100`) — own process group, stdin closed. Cancellation: SIGTERM to the *group* via `process.kill(-pid)`, 5 s grace (`CANCEL_SIGKILL_TIMEOUT_MS`), then group SIGKILL plus direct `child.kill` fallback, awaiting actual exit (`process-runner.ts:125-156, 254-267`). Exit promise created before listener attach and bound to `close` (not `exit`) to avoid fast-exit races and lost final partial lines (`process-runner.ts:104-111`); trailing empty lines suppressed, final partial line flushed on stream end (`process-runner.ts:205-239`).
- **Prompt-injection hygiene**: nonce fences + directive line + ANSI/control stripping + secret redaction (§3.4); debug logger redacts values whose key matches `/token|secret|password|authorization|credential/i` and truncates strings >500 chars (`src/debug-log.ts:5-28`).
- **Failure isolation**: scheduler swallows delivery errors and keeps loops alive (`prompt-scheduler.ts:138-144`); queue flush catches handler exceptions without deadlocking (`idle-queue.ts:200-211`, `delivery-queue.ts:107-130`); delivery failure marks the job `failed/bridge_failed` rather than surfacing into the conversation (`src/index.ts:177-184`).

---

## 5. TUI Indicator (`src/tui.tsx`)

- A SolidJS/OpenTUI plugin (`id = 'opencode-monitor-indicator'`, `tui.tsx:15`) registered into OpenCode TUI slots: `sidebar_title`, `session_prompt_right`, `home_prompt_right`, `home_bottom`, `app_bottom`, `sidebar_content`, `sidebar_footer` (`tui.tsx:191-233`).
- **State source**: polls `readMonitorStatus(scope)` every 1000 ms (`tui.tsx:43-45`) from the file-based status store; scope = worktree || directory || cwd (`tui.tsx:21-23`). The server side writes a `MonitorIndicatorSnapshot { version: 1, updatedAt, jobs: [{jobID, kind, sessionID, status, startedAt, updatedAt}] }` (`src/status-store.ts:9-22`) on every job state change via `emitStatus()` (`src/index.ts:128-146`) — only jobs still present in `runtimes` (i.e., live) are included.
- **What it shows**: compact chip `jobs <jobID>:<kind> [...] +N` or `jobs idle` (`tui.tsx:100-104, 118-135`); detail panel with per-job rows (`jobID`, kind title, status with `active` shown as `running`, `tui.tsx:65-68, 137-189`), per-kind colored bullets (mon=warning, loop=success, sched=accent, bg=muted; `tui.tsx:70-75`), status colors (failed=error, cancelled=muted, completed=success, else warning; `tui.tsx:77-82`), a summary like `bg×1 · mon×2` (`tui.tsx:84-98`), and an idle-state help listing the four slash commands (`tui.tsx:146-163`).
- Session filtering falls back to *all* project jobs when the session-filtered list is empty (restart/attach mismatch hedge, `tui.tsx:30-36`).

For Pi: the data model (snapshot of live jobs per kind/status) ports directly to whatever in-process status/widget API Pi has; the file polling and separate TUI process do not.

---

## 6. Slash-Command-as-Prompt-Template + AI-Callable-Tool Dual Interface

OpenCode commands can only expand to prompt text, so each slash command is a **template instructing the model to call the corresponding tool**:

- `config()` hook injects six commands (`background`, `monitor`, `loop`, `schedule`, `jobs`, `cancel`) with descriptions (`COMMAND_DESCRIPTIONS`, `src/index.ts:80-87`) and templates of the form `` Use the `opencode_monitor_background` tool with command exactly as written below. Return the tool result.\n\n$ARGUMENTS `` (`COMMAND_TEMPLATES`, `src/index.ts:89-96`; injection at `:486-491`).
- The tools — `opencode_monitor_background`, `opencode_monitor_monitor`, `opencode_monitor_loop`, `opencode_monitor_schedule`, `opencode_monitor_jobs`, `opencode_monitor_cancel` (`src/index.ts:492-557`) — take a single raw-string arg (`command`, `raw`, or `jobID`) and delegate to the same shared `handlers` map (`src/index.ts:186-357`) used by the test-facing `registerSlashCommand` path (`src/index.ts:359-366`). The raw string is then run through the §2 parsers, so **slash syntax and tool syntax are identical** (e.g., the monitor tool's `raw` is the literal `/monitor` argument string including `--regex ... -- cmd`).
- Net effect: one parser/handler core, two entry points; the model is the conduit for slash commands (it sees and echoes job IDs/results). In Pi, slash commands can call handler code directly, so the template indirection is unnecessary — but keeping the *tool* interface is still valuable so the agent can start jobs autonomously, and the raw-string grammar can be replaced by structured tool params.

---

## 7. PORT / ADAPT / DROP Table

| Component | File | Verdict | Reasoning |
|---|---|---|---|
| Job model (kinds, states, deliveryStatus) | `src/types.ts` | **PORT** | Clean domain model; drop only `bridge_failed` naming. |
| `JobRegistry` | `src/registry/job-registry.ts` | **ADAPT** | Keep caps/lifecycle/retention; store real sessionID per entry instead of the vestigial constant `sessionRef` + external `runtimes` map. |
| `ProcessRunner` (spawn/tails/group-kill) | `src/runner/process-runner.ts` | **PORT** | Self-contained, race-hardened, OpenCode-agnostic; best code in the repo. |
| `MonitorEngine` (before/after/debounce/merge/dedupe) | `src/runner/monitor-engine.ts` | **PORT** | Pure logic, no host coupling; also enforce the unwired 16 KiB/200-event delivery caps. |
| `ReDoSWorker` + thread | `src/runner/redos-worker.ts`, `redos-thread.ts` | **ADAPT** | Good design but currently dead code — actually wire it into pattern vetting/line matching, or swap for RE2. |
| Parsers (`background`/`monitor`/`loop`/`schedule`/`time-utils`) | `src/parser/*.ts` | **ADAPT** | Keep grammars and limits for slash input; tools can take structured params instead of raw strings. |
| `PromptScheduler` | `src/scheduler/prompt-scheduler.ts` | **PORT** | Plain timer logic (no-backlog loop chaining, one-shot, cancel); host-independent. |
| `IdleQueue` (idle gating + loop coalescing + caps) | `src/bridge/idle-queue.ts` | **ADAPT** | Semantics worth keeping; replace event-sniffed session status with Pi's native turn/idle lifecycle, drop legacy `__default__` mode. |
| `BridgeServer` (HTTP, routes, token, config file) | `src/bridge/server.ts` | **DROP** | Exists only because OpenCode plugins lack in-process message injection; Pi injects directly. |
| `notifier.ts` (HTTP client + health preflight) | `src/delivery/notifier.ts` | **DROP** | Bridge client; replace with a direct in-process deliver function. |
| `DeliveryQueue` (10-min TTL bridge buffer) | `src/delivery/delivery-queue.ts` | **DROP** | Unwired even here; only mitigates bridge unavailability, which has no Pi equivalent. |
| `delivery-formatter.ts` (nonce fence, sanitize, redact) | `src/delivery/delivery-formatter.ts` | **PORT** | Prompt-injection/secret hygiene applies identically to injected messages in Pi. |
| Synthetic-prompt / MCP notification contract | `src/index.ts:378-422`, `docs/opencode-custom-contract.md` | **DROP** | Pure transport for the missing injection API; Pi has message injection. |
| Idle-fallback hack (`armIdleFallback`, busy-on-tool-call) | `src/index.ts:431-436, 498-503` | **DROP** | Workaround for unreliable out-of-process status events. |
| `status-store.ts` (file-based snapshot) | `src/status-store.ts` | **DROP** | Cross-process IPC for the TUI; in-process Pi extension shares state directly. |
| TUI indicator | `src/tui.tsx` | **ADAPT** | Keep displayed model (per-kind counts, job rows, colors, idle help); rebuild on Pi's widget/statusline API without file polling. |
| Slash-command prompt templates | `src/index.ts:89-96, 486-491` | **DROP** | Pi slash commands can invoke handlers directly; no model round-trip needed. |
| AI-callable tools (6×) | `src/index.ts:492-557` | **ADAPT** | Keep tool surface for agent autonomy; switch raw-string args to structured schemas; keep `jobs`/`cancel` session scoping. |
| `requireDirectUserContext` origin gate | `src/plugin-context.ts:10-16` | **ADAPT** | Intent (limit who can start jobs) is good; current enforcement is a no-op via `toolPluginContext` — decide a real policy in Pi. |
| `limits.ts` | `src/limits.ts` | **PORT** | Sane, battle-tested values; drop the three bridge-specific constants. |
| `debug-log.ts` (redacting JSONL logger) | `src/debug-log.ts` | **ADAPT** | Useful pattern; point at Pi's logging facility/paths. |
