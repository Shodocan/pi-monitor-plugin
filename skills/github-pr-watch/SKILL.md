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
   - User said "this repo" (or you are inside the repo they mean): run
     `gh repo view --json nameWithOwner -q .nameWithOwner` in the cwd and use scoped mode.
   - User said "my PRs" / "everything" / gave no repo: use cross-repo mode (no `--repo`).
2. **Pick the interval.** Default 300 seconds; honor phrasing like "every 2 minutes"
   (minimum 60 — `gh search` indexing lag makes faster polling pointless).
3. **Start the monitor.** The watcher script lives in this skill directory at
   `scripts/watch-prs.sh` — use its absolute path:

   ```
   /monitor --regex '^PI_EVENT ' -- <this-skill-dir>/scripts/watch-prs.sh --interval 300 --repo <owner/name>
   ```

   Cross-repo mode: same command without `--repo`. Optional flags: `--include-drafts`,
   `--include-bots` (bot PRs like dependabot are skipped by default).
4. **Confirm to the user**, e.g.: "Watching <scope> for review requests every 5 min — I'll
   summarize new PRs and ask before reviewing. `/jobs` to inspect, `/cancel <id>` to stop."

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

`/jobs` to find the monitor's job ID, then `/cancel <jobID>`. Watcher state (seen PR ids)
lives under `~/.local/state/pi-monitor/watch-prs/` and may be deleted freely — the only
consequence is a fresh baseline.

## Testing the pipeline

`scripts/watch-prs.sh --once` performs a single poll and exits — useful for verifying
`gh` auth and inspecting the raw `PI_EVENT` output before starting a monitor.
