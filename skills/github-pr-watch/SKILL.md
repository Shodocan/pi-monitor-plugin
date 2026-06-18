---
name: github-pr-watch
description: Watch GitHub for pull requests awaiting the user's review and notify the session when new review requests appear. Use when the user asks to watch a repo (or all repos) for PRs, babysit their review queue, get pinged about review requests, or stop such a watch.
---

# GitHub PR review watcher

Starts a background monitor that polls GitHub for open pull requests where the user's
review is requested, and delivers a structured event into this session for each new one.
Polling uses the ambient `gh` CLI authentication — no tokens are read or stored.

## Prerequisites

- `gh` CLI installed and authenticated (`gh auth status` must succeed).
- `jq` installed.
- The pi-monitor extension active (this skill ships with it).

If `gh auth status` fails, tell the user to run `gh auth login` themselves — never attempt
to authenticate on their behalf.

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

Pass `jobs_monitor` params directly:

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

## When an event arrives

Deliveries contain one `PI_EVENT` JSON line per new PR
(`{"v":1,"type":"pr_review_requested","repo":...,"number":...,"url":...}`). For each:

1. Run `gh pr view <url>` (add `--json title,body,additions,deletions,statusCheckRollup`
   if you need structure) for a cheap enrichment.
2. Give the user a 2–3 line summary: what it changes, size, CI status.
3. Ask whether they want you to start a review. **Never review, comment, or approve
   without explicit confirmation.** If the author is a bot and it is a routine dependency
   bump, say so and offer a quick skim instead.

A `{"type":"baseline","count":N}` event on first run means N requests already existed —
report the count once, do not enumerate them unless asked.

## Stop watching

Run `/jobs`, find the `mon_*` job, then `/cancel <jobID>`.

```text
/jobs
/cancel mon_1
```

Watcher state (seen PR ids) lives under `~/.local/state/pi-monitor/watch-prs/` and may be
deleted freely — the only consequence is a fresh baseline.

## Testing the pipeline

`scripts/watch-prs.sh --once` performs a single poll and exits — useful for verifying
`gh` auth and inspecting the raw `PI_EVENT` output before starting a monitor.
