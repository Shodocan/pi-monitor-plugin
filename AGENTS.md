# AGENTS.md — guide for coding agents working in this repo

This repo is a **pi package** (extension + skill) providing background/monitor/loop/schedule
jobs for the pi coding agent. It is currently a planned scaffold: **read [PLAN.md](PLAN.md)
first** — it contains the architecture, locked-in design decisions, milestones, and a
references section pointing at the four research reports in [docs/research/](docs/research/).
Do not relitigate decisions marked as already made in PLAN.md §3.5 without new evidence.

## Ground rules

- **No build step.** Pi loads `extensions/*.ts` uncompiled via jiti. Never add a compile
  step to the runtime path; `tsc --noEmit` is for typechecking only.
- **TypeBox, not zod.** Tool parameter schemas use `Type.*` from `typebox` and `StringEnum`
  from `@earendil-works/pi-ai` (plain `Type.Union(Type.Literal(...))` breaks Gemini).
- **Dependency rules** (from pi's packages.md): pi-bundled packages
  (`@earendil-works/pi-coding-agent`, `pi-ai`, `pi-agent-core`, `pi-tui`, `typebox`) go in
  `peerDependencies` with `"*"` and must never be bundled. Real third-party runtime deps go
  in `dependencies` (pi runs `npm install --omit=dev` on install, so `devDependencies` are
  absent at runtime).
- **Lifecycle discipline.** The extension factory re-runs on `/reload`, `/new`, `/resume`,
  `/fork`; module top-level state does not survive. Create timers/watchers/child processes
  in `session_start`, tear them down in `session_shutdown`, keep handles in factory-closure
  variables. A captured `pi`/`ctx` from a previous session throws when used.
- **Never call `pi.sendUserMessage` without `deliverAs` unless `ctx.isIdle()`** — it throws
  while streaming. Prefer `pi.sendMessage({customType: "pi-monitor", ...})` for deliveries.
- **Output discipline.** Everything delivered to the session or returned from tools is
  capped (see PLAN.md §7) and nonce-fenced/sanitized (PLAN.md §6). Never put unbounded
  process output into context.
- **Relative imports use explicit `.ts` extensions** (`from "../src/registry.ts"`), per
  pi's example-extension idiom.

## Secrets and privacy — hard requirements

- This is a **public repo and (eventually) a public npm package**. Never commit tokens,
  API keys, personal endpoints, internal hostnames, or employer/private org repo names —
  including in docs, examples, sample payloads, and test fixtures. Use `acme-org/example-service`
  style placeholders.
- The GitHub watcher must rely exclusively on ambient `gh` auth. No token reading, storage,
  or prompting, ever.
- Before any commit that adds docs or fixtures, scan the diff for secrets and real
  repo/host names.

## Verification

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm pack --dry-run  # inspect what would be published, before any release
```

Manual smoke testing happens inside pi: `pi -e .` then the commands in PLAN.md §5.

## Key external references

- Installed pi package (find it with `npm root -g`): `@earendil-works/pi-coding-agent/`
  - `docs/extensions.md` — extension API bible
  - `docs/packages.md`, `docs/skills.md`, `docs/settings.md`
  - `dist/core/extensions/types.d.ts` — authoritative API types
  - `examples/extensions/` — copy patterns from `file-trigger.ts`, `send-user-message.ts`,
    `subagent/`, `status-line.ts`, `todo.ts`, `truncated-tool.ts`
- Port source: the sibling checkout `../opencode-monitor-plugin`
  (github.com/Shodocan/opencode-monitor-plugin). Its `src/runner/*` and
  `src/delivery/delivery-formatter.ts` and `test/` suite are the best material to lift;
  its bridge/MCP transport layers are intentionally not ported (PLAN.md §2).
