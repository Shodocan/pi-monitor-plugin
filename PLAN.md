# PLAN.md — pi-monitor-plugin implementation plan

> **Status: planning / bootstrap.** This repo is a scaffold plus this plan. The implementing
> session should work through the milestones below in order. The deep research that backs
> every claim here lives in [`docs/research/`](docs/research/) — read those four reports
> before writing code.

## 1. Goal

Port the ideas of [`opencode-monitor-plugin`](https://github.com/Shodocan/opencode-monitor-plugin)
to the [pi coding agent](https://github.com/badlogic/pi-mono) as a single **pi package**
(installable via `pi install npm:pi-monitor-plugin`) that provides:

- `/background <command>` — run a long shell command without blocking the turn; deliver the capped tail on exit.
- `/monitor --regex <pattern> [--before N] [--after N] [--debounce S] -- <command>` — watch a long-running command's output and deliver matching windows.
- `/loop <interval> <prompt>` — repeatedly submit a prompt; ticks that land while the agent is busy coalesce.
- `/schedule in <duration> <prompt>` / `/schedule at <iso> <prompt>` — one-shot future prompt.
- `/jobs`, `/cancel <jobID>` — inspect and stop jobs.
- Matching AI-callable tools so the agent can start jobs autonomously.
- Idle-aware delivery: never interrupt a busy turn by default.
- A TUI footer/widget indicator of active jobs.
- A **skill** (`skills/github-pr-watch/`) that teaches the model the flagship use case:
  *watch GitHub for PRs awaiting my review and notify the session*.

**Flagship demo (the bar for "v0.1 works"):**

```
/monitor --regex '^PI_EVENT ' -- ./skills/github-pr-watch/scripts/watch-prs.sh --interval 300
```

→ a new review request on GitHub appears as a message in the pi session within one poll
interval, the model summarizes the PR and asks whether to start reviewing.

## 2. Why the Pi version is much simpler than the OpenCode original

The OpenCode plugin needed a custom opencode build (`och`), a loopback **HTTP bridge** with
bearer tokens, an MCP synthetic-prompt notification contract, a file-based status store for
the out-of-process TUI, and idle-detection hacks — all because OpenCode plugins cannot
inject messages into a session in-process.

**Pi extensions run in-process and have first-class message injection** (`pi.sendMessage`,
`pi.sendUserMessage` with `deliverAs: "steer" | "followUp" | "nextTurn"`), first-class idle
detection (`ctx.isIdle()`), and first-class UI surfaces (`ctx.ui.setStatus/setWidget/notify`).

Per the PORT/ADAPT/DROP analysis (full table:
[`docs/research/oc-architecture.md`](docs/research/oc-architecture.md) §7):

| Verdict | Components |
|---|---|
| **PORT** (logic is host-agnostic, battle-tested) | `ProcessRunner` (spawn/tail/group-kill), `MonitorEngine` (before/after/debounce/window-merge), `PromptScheduler`, `delivery-formatter` (nonce fencing, ANSI strip, secret redaction), `limits.ts` values, job model types |
| **ADAPT** | `JobRegistry` (store real session scoping), `IdleQueue` semantics (rebuild on `ctx.isIdle()` + Pi turn lifecycle), parsers (keep grammar for slash input; tools get structured TypeBox params), TUI indicator (rebuild on `ctx.ui.setWidget`/`setStatus`), ReDoS vetting (wire it in for real — it was dead code upstream), AI tools (structured schemas) |
| **DROP** | HTTP bridge server + bearer tokens + config-file handshake, HTTP notifier + health preflight, `DeliveryQueue` TTL buffer, MCP synthetic-prompt contract, idle-fallback hacks, file status store, slash-command→prompt-template indirection |

Roughly **half the original codebase is transport workaround and does not get ported.**

## 3. Architecture

```
extensions/
└── pi-monitor.ts          # entry: factory(pi) — registers commands, tools, lifecycle hooks
src/
├── types.ts               # JobKind 'bg'|'mon'|'loop'|'sched'; JobState; JobRecord
├── limits.ts              # ported caps (see §7)
├── registry.ts            # JobRegistry: ids (bg_1, mon_2…), lifecycle, retention, session scoping
├── runner/
│   ├── process-runner.ts  # /bin/sh -c spawn, detached group, tail buffers, SIGTERM→SIGKILL
│   ├── monitor-engine.ts  # ring buffer, regex windows (before/after), debounce, merge+dedupe
│   └── redos.ts           # pattern vetting at job start (worker_threads timeout, or RE2)
├── scheduler.ts           # loop chaining (no backlog) + one-shot schedule timers
├── parser/                # slash-arg grammars ported 1:1 (background/monitor/loop/schedule)
├── delivery.ts            # THE PI-NATIVE PART: idle gate + coalescing + nonce fence + redaction
└── ui.ts                  # setStatus footer chip + setWidget job panel
skills/
└── github-pr-watch/
    ├── SKILL.md           # natural language → tool invocation (written, see file)
    └── scripts/
        └── watch-prs.sh   # gh-based poller emitting PI_EVENT lines (reference impl included)
```

Extensions are **TypeScript loaded uncompiled via jiti** — no build step, ever
(extensions.md:178). `extensions/pi-monitor.ts` imports from `../src/*.ts` with explicit
`.ts` extensions (idiomatic — the shipped `subagent` example does this).

### 3.1 Extension entry contract

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) { /* register everything */ }
```

Key lifecycle rules (verified against pi v0.79.1 source — citations in
[`docs/research/pi-api-reference.md`](docs/research/pi-api-reference.md)):

- The factory **re-runs from scratch** on `/reload`, `/new`, `/resume`, `/fork`
  (jiti `moduleCache: false`). Top-level module state does NOT survive.
- Timers, watchers, and child processes are **not cleaned up automatically** and the old
  `pi`/`ctx` become stale (calls throw). Therefore: create runtime state in
  `session_start`, tear it down in `session_shutdown` (fires for
  `"quit"|"reload"|"new"|"resume"|"fork"`). Keep handles in factory-closure variables.
- Decision needed at M1: do jobs survive `/new`? Recommendation: **kill all jobs in
  `session_shutdown`** for v0.1 (matches OC in-memory v1 semantics); persistence is a
  later milestone (see Open Questions).
- `pi.*` action methods are throwing stubs at load time — register at load, act only from
  handlers.

### 3.2 Delivery decision tree (the heart of the port)

Exact semantics, verified against `agent-session.js` (citations in research doc §2):

- `steer` — queued; delivered after the current assistant message's tool calls finish,
  before the next LLM call (turn boundary, not mid-token).
- `followUp` — delivered only when the agent run fully winds down.
- `nextTurn` (`sendMessage` only) — buffered until the next user prompt; never interrupts.
- `pi.sendUserMessage` **throws** if the agent is streaming and `deliverAs` is omitted.
  `pi.sendMessage` never throws (streaming default = steer queue).

Policy for this plugin:

```
event ready for delivery:
  ctx.isIdle()
    → pi.sendMessage({customType:"pi-monitor", content, display:true}, {triggerTurn:true})
  busy + job urgency == "polite" (DEFAULT)
    → pi.sendMessage(..., {deliverAs:"nextTurn"})    // plus ctx.ui.notify toast
  busy + job urgency == "interrupt" (--deliver steer opt-in flag)
    → pi.sendMessage(..., {deliverAs:"steer"})
loop ticks while busy → coalesce: keep latest only, count skipped,
  annotate "[coalesced N loop ticks while session was busy]"
```

`sendMessage` with a `customType` is preferred over `sendUserMessage` so deliveries are
(a) visually distinct via `registerMessageRenderer`, (b) not attributed as typed user input.
This is exactly the shipped `file-trigger.ts` pattern.

### 3.3 Tool + command surface

Slash commands call handler code **directly** (no prompt-template indirection — that was an
OpenCode limitation). The same handlers back AI-callable tools with **structured TypeBox
params** (NOT zod, NOT raw JSON schema; use `StringEnum` from `@earendil-works/pi-ai` for
enums — `Type.Union(Type.Literal(...))` breaks Gemini):

| Slash command | Tool | Params (TypeBox) |
|---|---|---|
| `/background <cmd>` | `jobs_background` | `{ command: string }` |
| `/monitor … -- <cmd>` | `jobs_monitor` | `{ command, regex, before?, after?, debounceSeconds?, deliver? }` |
| `/loop <interval> <prompt>` | `jobs_loop` | `{ intervalSeconds, prompt }` |
| `/schedule …` | `jobs_schedule` | `{ at?: string, inSeconds?: number, prompt }` |
| `/jobs` | `jobs_list` | `{}` |
| `/cancel <id>` | `jobs_cancel` | `{ jobID }` |

Tool `execute` returns immediately with `started <jobID>` while work continues in closure
state — the agent only awaits the returned promise, so fire-and-return is supported.
Truncate any tool output to ≤50KB/2000 lines using pi's exported `truncateTail` helpers.

### 3.4 Watcher script protocol (`PI_EVENT`)

One line per event on **stdout**: sentinel + single-line JSON (`jq -c`), target <500 bytes.
Heartbeats/debug/errors go to **stderr** so the regex window carries only signal.

```
PI_EVENT {"v":1,"type":"pr_review_requested","repo":"acme-org/example-service","number":873,"title":"…","url":"https://github.com/acme-org/example-service/pull/873","author":"dependabot[bot]","bot":true,"draft":false,"updatedAt":"2026-06-09T16:34:59Z"}
PI_EVENT {"v":1,"type":"baseline","count":4,"scope":"all"}
PI_EVENT {"v":1,"type":"error","message":"gh: auth required"}
```

Required keys: `v`, `type`. Always include `url` when one exists — it is the one field the
model can act on directly (`gh pr view <url>`). Monitor invocations for any watcher script
always use `--regex '^PI_EVENT '`. Full protocol rationale:
[`docs/research/use-case-design.md`](docs/research/use-case-design.md) §3.

### 3.5 GitHub PR watcher design decisions (already made — don't relitigate)

- **Data source:** `gh search prs --review-requested=@me --state=open --json id,number,title,url,repository,author,isDraft,updatedAt --limit 50`.
  One call covers all repos; PRs drop out automatically once reviewed; rate cost trivial at
  ≥60s intervals. ETag polling and the notifications API were evaluated and rejected
  (research doc §1.1 — notifications share read-state with the web UI; rejected).
- **Zero-secret invariant:** the script never reads or stores tokens — all auth is ambient
  `gh` auth. If `gh auth status` fails, emit one `error` event and exit non-zero. Never prompt.
- **State:** `${XDG_STATE_HOME:-$HOME/.local/state}/pi-monitor/watch-prs/<scope>.json`
  holding `{version, seen: {<prNodeId>: updatedAt}, lastPoll}`. Dedupe key = GraphQL node
  `id`. Write state *after* emitting (at-least-once). Evict ids absent >7 days (re-fires on
  re-requested reviews). First run seeds `seen` and emits a single `baseline` event instead
  of N stale ones.
- **Filters:** skip drafts and bot authors unless `--include-drafts` / `--include-bots`.
- **Delivery default: polite** (`nextTurn` + toast). `--deliver steer` is opt-in for
  genuinely urgent watchers (prod incidents). A PR review request is ambient, not urgent.
- **Generic path ships first** (`/monitor` + script proves the engine; zero bespoke
  extension code), native `/watch-prs` sugar second — and if built, it shells out to the
  same script with `--once` so there is one source of truth for the GitHub logic.

## 4. Milestones

Each milestone must end green: `npm run typecheck && npm test`.

- **M0 — Core engine (no pi):** port `types`, `limits`, `JobRegistry`, `ProcessRunner`,
  `MonitorEngine`, `PromptScheduler`, parsers, formatter as pure modules under `src/` with
  vitest coverage ported/adapted from the OC repo's 14 test files. Everything here is
  host-agnostic — copy liberally from the sibling repo, drop bridge imports.
  Also: actually enforce the per-delivery caps (16 KiB / 200 events) that were declared but
  unwired upstream, and wire ReDoS vetting at job start (it was dead code upstream).
- **M1 — Pi wiring:** `extensions/pi-monitor.ts` registers the 6 commands + 6 tools backed
  by shared handlers; `delivery.ts` implements §3.2; lifecycle per §3.1. Manual smoke:
  `pi -e .` then `/background sleep 2 && echo done`.
- **M2 — UI:** footer chip via `ctx.ui.setStatus("pi-monitor", "jobs bg×1 mon×2")`;
  `/jobs` renders a table; optional `setWidget` panel; `registerMessageRenderer` for the
  `pi-monitor` customType. Guard everything with `ctx.hasUI`.
- **M3 — Flagship:** finalize `watch-prs.sh` against the reference design, end-to-end demo
  per §1, polish `skills/github-pr-watch/SKILL.md` against real model behavior.
- **M4 — Package polish:** `pi install ./` and `pi -e .` verified; README install matrix
  (npm / git / local) tested; `npm pack --dry-run` inspected; secret scan; CI (typecheck +
  test on node 22).
- **M5 — Publish:** `npm publish --access public` (requires `npm login`, not configured on
  this machine yet); tag `v0.1.0`; optional: add `pi.image` for the pi.dev gallery.

## 5. Smoke tests (manual, after M1)

```bash
pi -e .                                  # load package ad-hoc
/background sh -c "sleep 2; echo done"  # → toast + delivered tail after exit
/monitor --regex 'PI_SMOKE' -- sh -c "sleep 2; printf 'PI_SMOKE ok\n'"
/loop 15s say tick                       # then keep the agent busy → expect coalescing
/schedule in 1m say hello
/jobs && /cancel <id>
```

## 6. Safety requirements (non-negotiable, ported from OC)

- Nonce-fence all delivered process output (16 random bytes hex framing) so untrusted
  output can't impersonate directives; strip ANSI/OSC/control chars; best-effort secret
  redaction (`TOKEN|API_KEY|SECRET|PASSWORD|PRIVATE_KEY` k/v patterns, `Bearer` headers,
  URL userinfo).
- `spawn('/bin/sh', ['-c', cmd], {detached: true, stdio: ['ignore','pipe','pipe']})`;
  cancel = SIGTERM to the process *group*, 5s grace, then SIGKILL; await real exit.
- Regex: 512-char pattern cap, reject `g`/`y` flags, vet against pathological input in a
  worker thread with 100ms timeout before accepting the job.
- All output capped (see §7); never put unbounded logs into context.
- No tokens, endpoints, or personal infra anywhere in this repo — the watcher relies on
  ambient `gh` auth only.

## 7. Limits (ported values — keep unless a milestone proves otherwise)

| Limit | Value |
|---|---|
| Max active jobs | 20 |
| Completed retention | 50 |
| Output tail cap (per stream) | 200 lines / 32 KiB |
| Monitor ring buffer | 50,000 events |
| Monitor after-context wait | 5 s |
| Monitor debounce | 1–60 s, default 5 s |
| Per-delivery cap | 16 KiB / 200 events (**enforce** — unwired upstream) |
| Regex pattern length | 512 |
| Loop interval minimum | 10 s |
| Schedule horizon | 30 days |
| Pending deliveries | 20/job, 100 global, 1 MiB total |
| ReDoS vetting | 100 ms timeout, 4 workers |
| Cancel SIGKILL grace | 5 s |

## 8. Open questions (decide during implementation)

1. **Job persistence across `/new`/restart** — v0.1: jobs die with the session (in-memory,
   matches OC). Later: persist job manifests via `pi.appendEntry` + reconstruct in
   `session_start`, or a detached-runner design. Raises value a lot; raises complexity too.
2. **Coalescing window for multiple `PI_EVENT` lines in one poll** — recommended: one
   delivery per poll cycle (the debounce already approximates this).
3. **Native `/watch-prs` command (integration shape b)** — only after M3 proves the generic
   path; it wraps the same script with `--once` + `setInterval` in-process and gets a
   persistent `setWidget` badge ("3 PRs awaiting review").
4. **`gh search` indexing lag** (~seconds to ~1 min) — acceptable at 300s polls; document it.

## 9. References

- **Research reports (this repo, read first):**
  - [`docs/research/oc-architecture.md`](docs/research/oc-architecture.md) — full OC plugin dissection, exact limits, PORT/ADAPT/DROP table.
  - [`docs/research/pi-api-reference.md`](docs/research/pi-api-reference.md) — every pi API signature needed, with `types.d.ts` / `extensions.md` line citations, pitfalls list.
  - [`docs/research/skills-packaging.md`](docs/research/skills-packaging.md) — SKILL.md format, package manifest rules, install UX.
  - [`docs/research/use-case-design.md`](docs/research/use-case-design.md) — watcher script design, PI_EVENT protocol, delivery UX.
- **Source of port:** `../opencode-monitor-plugin` (sibling checkout; also github.com/Shodocan/opencode-monitor-plugin). Best code to lift: `src/runner/process-runner.ts`, `src/runner/monitor-engine.ts`, `src/delivery/delivery-formatter.ts`, and the `test/` suite.
- **Pi docs (in the installed package, `$(npm root -g)/@earendil-works/pi-coding-agent/`):**
  `docs/extensions.md` (the bible), `docs/packages.md`, `docs/skills.md`, `docs/settings.md`,
  `dist/core/extensions/types.d.ts` (authoritative types).
- **Pi example extensions to copy patterns from** (same package, `examples/extensions/`):
  `file-trigger.ts` (external event → session message — the core mechanism),
  `send-user-message.ts` (idle/busy delivery), `subagent/` (long-running spawn + abort),
  `status-line.ts` (footer), `todo.ts` (state reconstruction), `truncated-tool.ts`,
  `dynamic-tools.ts`, `widget-placement.ts`.
- **Skill spec:** https://agentskills.io (pi implements it; lenient).
- **Package gallery:** https://pi.dev/packages (listed automatically via the `pi-package` keyword).
