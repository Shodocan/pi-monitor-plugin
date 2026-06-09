# pi-monitor-plugin

Background, monitor, loop, and schedule jobs for the [pi coding agent](https://github.com/badlogic/pi-mono),
with idle-aware session notifications and a TUI job indicator. Ships as a standard
**pi package**: one extension plus one skill.

> **Status: planning / scaffold.** The architecture and milestones live in [PLAN.md](PLAN.md);
> the deep research backing them lives in [docs/research/](docs/research/). The job engine is
> not implemented yet. This is the pi-native successor of
> [opencode-monitor-plugin](https://github.com/Shodocan/opencode-monitor-plugin) — and because
> pi extensions run in-process with first-class message injection, it needs none of the
> HTTP-bridge/MCP machinery the OpenCode version required.

## The flagship use case

A monitor runs a watcher script; the script polls GitHub for pull requests awaiting your
review and notifies your pi session:

```
/monitor --regex '^PI_EVENT ' -- ./skills/github-pr-watch/scripts/watch-prs.sh --interval 300
```

When a new review request appears, the session receives a structured event, summarizes the
PR, and asks whether you want to start reviewing — politely: by default it never interrupts
a turn that is already running.

## Capabilities (planned surface)

- `/background <command>` — run a long shell command without blocking the current turn; get the capped output tail when it exits.
- `/monitor --regex <pattern> [--before N] [--after N] [--debounce S] -- <command>` — watch a long-running command's output, deliver matching windows with context.
- `/loop <interval> <prompt>` — repeat a prompt; ticks missed while the agent is busy coalesce into one delivery.
- `/schedule in <duration> <prompt>` / `/schedule at <iso-date> <prompt>` — one-shot future prompt.
- `/jobs` / `/cancel <jobID>` — inspect and stop jobs.
- AI-callable tools (`jobs_background`, `jobs_monitor`, `jobs_loop`, `jobs_schedule`, `jobs_list`, `jobs_cancel`) so the agent can start jobs itself.
- Idle-aware delivery: busy sessions get a toast immediately and the message on the next turn boundary; `--deliver steer` opts a watcher into interrupting.
- Footer/widget indicator of active jobs.

### Other things a watcher can do

CI run babysitting, deploy watch, `tail -f` error watch, issue triage, test-on-save,
Dependabot/security alerts, release watch, long-build completion pings, disk-quota
sentinels, k8s crashloop watch — anything that can print a `PI_EVENT` line (see
[PLAN.md §3.4](PLAN.md) for the protocol).

## Install

Requires Node ≥ 22.19 and pi ≥ 0.79. The GitHub watcher additionally needs an
authenticated [`gh`](https://cli.github.com/) CLI — the plugin never touches tokens itself.

```bash
# from npm (once published)
pi install npm:pi-monitor-plugin

# from git, today
pi install git:github.com/Shodocan/pi-monitor-plugin

# try without installing
pi -e git:github.com/Shodocan/pi-monitor-plugin

# project-local (shared with your team via .pi/settings.json)
pi install -l npm:pi-monitor-plugin
```

Local development:

```bash
git clone https://github.com/Shodocan/pi-monitor-plugin
cd pi-monitor-plugin && npm install
pi -e .          # ad-hoc load for the current run
```

There is no build step: pi loads the TypeScript extension directly (jiti).

## Security model

- Pi packages run with full system access — review the source before installing, as with
  any pi package.
- Commands run through POSIX `/bin/sh -c` in their own process group; cancellation is
  SIGTERM → 5s grace → SIGKILL.
- Delivered process output is nonce-fenced (so untrusted output cannot impersonate
  instructions), ANSI/control-stripped, and best-effort secret-redacted.
- Regex patterns are length-capped and ReDoS-vetted before a monitor starts.
- The GitHub watcher stores no credentials — it relies entirely on ambient `gh` auth, and
  keeps only seen-PR ids under `~/.local/state/pi-monitor/`.

## Development

```bash
npm install
npm run typecheck
npm test
```

Before any release: `npm pack --dry-run` and a secret scan over the pack list.

## License

[MIT](LICENSE)
