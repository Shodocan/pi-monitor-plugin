# Design: PR-Review Watcher — flagship use case for the Pi background-jobs extension

**Status:** Design — no implementation. All command lines below verified against `gh` 2.x on the target machine (authenticated as `Shodocan`).

---

## 1. Watcher script: `watch-prs.sh`

A standalone polling script. No tokens, no config files required for the simple case — it inherits ambient `gh` auth and prints structured events to stdout.

### 1.1 Data-source comparison

| Approach | Multi-repo | Rate cost | Signal quality | Complexity |
|---|---|---|---|---|
| (a) `gh api` + `If-None-Match` ETag | Per-endpoint | Near-zero (304s don't count against core limit) | Good, but ETags are per-URL — multi-repo means one ETag per repo endpoint; the search endpoint does not honor conditional requests usefully | High: store/rotate ETags, handle 304 vs 200 vs ETag invalidation |
| (b) `gh search prs --review-requested=@me` | **One call covers all repos** | Search API: 30 req/min — trivial at a 300 s interval (0.2 req/min) | Exactly the set we want: open PRs where *my* review is requested and not yet submitted. PRs drop out automatically once reviewed | Low: one command, dedupe by id |
| (c) `gh api notifications` | Yes | Excellent (ETag + `X-Poll-Interval: 60` honored — verified) | Noisy: mentions, CI, issues, releases all mixed in; must filter `reason == "review_requested"`; thread payload lacks PR number/draft state (needs a second fetch per thread); read/unread state is shared with the web UI and other clients | Medium-high |

**Recommendation: (b).** One process-wide call, zero state beyond seen-IDs, the query semantics *are* the use case ("needs my review"), and rate limits are a non-issue at any sane interval. (a) is a future optimization if someone runs sub-60s intervals; (c) is rejected because shared read-state means marking threads read in the browser silently breaks the watcher, and vice versa.

### 1.2 Recommended command lines

Cross-repo (default mode — this is the flagship invocation):

```sh
gh search prs --review-requested=@me --state=open \
  --json id,number,title,url,repository,author,isDraft,updatedAt \
  --limit 50
```

Verified output shape (real sample from the target account):

```json
[{"author":{"login":"dependabot[bot]","is_bot":false,"type":"Bot","..."},
  "id":"PR_kwDOEXAMPLE000001","isDraft":false,"number":873,
  "repository":{"name":"example-service","nameWithOwner":"acme-org/example-service"},
  "title":"chore(deps): bump codecov/codecov-action from 6 to 7",
  "updatedAt":"2026-06-09T16:34:59Z",
  "url":"https://github.com/acme-org/example-service/pull/873"}]
```

Scoped mode (`--repo` flag, repeatable; appends `repo:` qualifiers to the same search):

```sh
gh search prs --review-requested=@me --state=open \
  --repo acme-org/example-service --repo Shodocan/pi-jobs \
  --json id,number,title,url,repository,author,isDraft,updatedAt --limit 50
```

Team-review variant (optional flag `--team org/team-slug`): `--review-requested=org/team-slug`.

### 1.3 Script interface

```
watch-prs.sh [--interval 300] [--repo owner/name ...] [--include-drafts] [--include-bots] [--once]
```

- **Fields used for the event:** `id` (dedupe key — GraphQL node ID, globally unique and stable), `repository.nameWithOwner`, `number`, `title` (truncate to 120 chars), `url`, `author.login`, `author.is_bot`, `isDraft`, `updatedAt`.
- **Filters:** skip `isDraft` unless `--include-drafts`; skip `author.is_bot` unless `--include-bots` (dependabot noise is real — see sample above).
- **`--once`:** single poll then exit — for testing and for use with `/loop` or cron instead of `/monitor`.

### 1.4 State file (XDG, zero secrets)

```
${XDG_STATE_HOME:-$HOME/.local/state}/pi-jobs/watch-prs/<scope>.json
```

`<scope>` = `all` for the cross-repo query, else a slug of the sorted `--repo` list (e.g. `acme-org__example-service`). State dir, not cache dir: losing it causes re-notification (annoying), not breakage — but it's authoritative state, so `state` is the right XDG bucket.

```json
{
  "version": 1,
  "seen": { "PR_kwDOEXAMPLE000001": "2026-06-09T16:34:59Z" },
  "lastPoll": "2026-06-09T17:00:00Z"
}
```

- New event ⇔ `id` not in `seen`. Write the file *after* emitting events (at-least-once delivery; the dedupe key makes the session-side idempotent enough).
- **Eviction:** drop IDs absent from results for > 7 days — this also re-fires when a review is *re-requested* after you reviewed (the PR re-enters the search results with a fresh absence gap).
- **First run:** seed `seen` from current results and emit a single summary event (`type: "baseline"`, count only) instead of N stale events.
- **Zero-secret invariant:** the script never reads/stores tokens; every API call goes through `gh`, which resolves auth itself. If `gh auth status` fails at startup, emit one `type:"error"` event and exit non-zero — never prompt.

### 1.5 Loop skeleton (design, not implementation)

```
check gh auth → load state → loop:
  results = gh search prs ... || emit error event (throttled, max 1/hour) and continue
  for pr in results: if pr.id not in seen and passes filters → emit event line
  update + persist state → log heartbeat to stderr → sleep $INTERVAL
```

Errors and heartbeats go to **stderr**; only protocol lines go to **stdout** (see §3) so the monitor regex window stays clean.

---

## 2. Integration shapes

### (a) Generic — ships first

```
/monitor --regex '^PI_EVENT ' -- ./scripts/watch-prs.sh --interval 300
```

The monitor watches the child's stdout, and each regex hit delivers the matched window into the session.

**Wins when:** proving the engine, anything `gh`/CLI-shaped, user-authored watchers, polyglot scripts. **This ships first** because:

1. It exercises and proves the generic `/monitor` engine end-to-end — the extension's actual product. If the flagship demo needs bespoke extension code, the generic engine looks like vaporware.
2. Zero new extension code: ship one shell script in `examples/`.
3. The script is independently useful (cron, CI, other agents) and independently testable (`./watch-prs.sh --once | jq`).
4. The protocol (§3) designed here becomes the contract any future watcher script gets for free.

### (b) Native — `/watch-prs` inside the extension

`setInterval` + `gh` child calls in-process; state in extension storage; `ctx.ui.setWidget` shows a persistent "3 PRs awaiting review" widget; richer per-event delivery decisions (steer vs nextTurn per PR priority).

**Wins when:** you want first-class TUI (widget/status line), survival across `/monitor` cancellation semantics, structured config persistence, or per-event delivery logic that a regex window can't express. **Ships second**, as sugar over the same `gh` queries — ideally literally shelling out to the same script with `--once`, so there is one source of truth for the GitHub logic.

---

## 3. Structured output protocol for watcher scripts

**One line per event: a sentinel prefix + single-line JSON.** Regex matches the sentinel; the JSON rides along inside the matched window.

```
PI_EVENT {"v":1,"type":"pr_review_requested","repo":"acme-org/example-service","number":873,"title":"chore(deps): bump codecov/codecov-action from 6 to 7","url":"https://github.com/acme-org/example-service/pull/873","author":"dependabot[bot]","bot":true,"draft":false,"updatedAt":"2026-06-09T16:34:59Z"}
```

Rules:

- **Sentinel** `PI_EVENT ` (space-terminated, line-anchored). Monitor invocation always uses `--regex '^PI_EVENT '`. One shared sentinel for all watcher scripts — not per-use-case — so docs/examples never vary.
- **One JSON object per line**, no pretty-printing, no embedded newlines (escape via `jq -c`). Target < 500 bytes; truncate `title` at 120 chars. Keeps the regex window small and the injected context clean.
- **Required keys:** `v` (protocol version), `type`. Everything else is event-defined. For `pr_review_requested`: `repo`, `number`, `title`, `url`, `author`, `bot`, `draft`, `updatedAt`. Include `url` always — it's the one field the model can act on (`gh pr view <url>`) without reconstructing anything.
- **Other event types:** `baseline` (`{"v":1,"type":"baseline","count":4,"scope":"all"}`, first run), `error` (`{"v":1,"type":"error","message":"gh: auth required"}`).
- **stdout is protocol-only.** Heartbeats (`[watch-prs] polled, 0 new`), debug, and gh stderr noise go to stderr. This is the load-bearing convention that makes the regex window deliver *only* signal.
- N new PRs ⇒ N lines ⇒ N matches; the monitor may batch them into one delivery — protocol works either way because each line is self-contained.

---

## 4. Delivery UX

### Injected message (literal template)

The extension wraps the matched window in instructions — the model should act, not just acknowledge:

```
[background monitor "watch-prs"] New pull request(s) requesting your user's review:

PI_EVENT {"v":1,"type":"pr_review_requested","repo":"acme-org/example-service","number":873,...}

For each PR above: run `gh pr view <url>` to fetch details, then give the user a
2-3 line summary (what it changes, size, CI status) and ask whether they want you
to start a review now. Do NOT start reviewing, commenting, or approving without
explicit confirmation. If the author is a bot and the change is a routine
dependency bump, say so and offer to skim it quickly instead.
```

Design points: name the monitor (so the user can `/cancel` it), keep the raw event line (machine-readable ground truth), instruct a cheap enrichment step (`gh pr view`), and hard-stop before any mutating action.

### Steer vs polite — recommendation: **polite by default**

A review request is ambient, not urgent; interrupting a mid-flight refactor to talk about someone else's PR is exactly the behavior that makes users uninstall background extensions.

| Session state | Action |
|---|---|
| `ctx.isIdle()` → true | `pi.sendUserMessage(text)` — starts a new turn immediately; the summary is waiting when the user looks back |
| Busy | `{deliverAs: "nextTurn"}` — non-interrupting aside, surfaces after the current turn completes |
| Always | `ctx.ui.notify("New PR: oncall-system#873 — review requested")` + `ctx.ui.setStatus` badge, so the human sees it even mid-turn |

Offer `--deliver steer` as an opt-in flag on `/monitor` for genuinely urgent watchers (prod incidents, deploy failures) — but PR review defaults to polite. Multiple events arriving while busy are coalesced into one nextTurn delivery.

---

## 5. README one-liners — other use cases

- **CI watch:** `/monitor --regex '^PI_EVENT ' -- ./watch-ci.sh --run <id>` — tell me when this workflow run finishes, and debug it if it failed.
- **Deploy watch:** poll the deploy status endpoint; steer-interrupt on failure, polite note on success.
- **Log tail:** `/monitor --regex 'ERROR|panic' -- tail -f /var/log/app.log` — raw regex mode, no script needed.
- **Issue triage:** poll `gh search issues --mention @me` / new issues with a label; have the model draft a triage comment for approval.
- **Test-on-save:** `/monitor --regex 'FAIL' -- watchexec -e ts -- npm test` — the model sees failures the moment you save.
- **Dependabot/security alerts:** poll `gh api /repos/{owner}/{repo}/dependabot/alerts`; summarize severity and offer the bump.
- **Release watch:** notify when a dependency you pin cuts a new release; offer the upgrade PR.
- **Long build babysitter:** `/background make -j8` then ping when done — "your 40-minute build finished, 2 warnings."
- **Disk/quota sentinel:** cheap shell loop; steer-interrupt at 95% because that one *is* urgent.
- **k8s crashloop watch:** `kubectl get events --watch` piped through a filter; deliver pod + reason.

---

## 6. Skill flow: "watch this repo for PRs"

Ship a skill (`skills/watch-prs/SKILL.md`) so natural language maps to the right tool call:

1. **Trigger:** user says "watch this repo for PRs", "tell me when I get review requests", "babysit my review queue".
2. **Skill instructs the model to:**
   - Resolve scope: if the user said "this repo", run `gh repo view --json nameWithOwner -q .nameWithOwner` in the cwd → scoped mode; if they said "my PRs"/"anything", use cross-repo mode (no `--repo`).
   - Pick interval: default 300; honor "every N minutes" from the user's phrasing.
   - Call the monitor tool — exact invocation:
     ```
     /monitor --regex '^PI_EVENT ' -- <extension-dir>/scripts/watch-prs.sh --interval 300 --repo acme-org/example-service
     ```
     (cross-repo: same line minus `--repo`.)
   - Confirm to the user: *"Watching acme-org/example-service for review requests every 5 min — I'll summarize new PRs and ask before reviewing. `/jobs` to inspect, `/cancel` to stop."*
3. **Skill also documents the stop path** ("stop watching" → `/jobs` to find the id → `/cancel <id>`), and the escalation path ("interrupt me for these" → re-create with `--deliver steer`).

---

## Open questions (for implementation phase)

- Coalescing window for multiple `PI_EVENT` lines in one poll (deliver as one message? recommended: yes, single delivery per poll cycle).
- Should `/monitor` persist across Pi restarts (resurrect from a jobs manifest) or die with the session? Flagship demo works either way; persistence raises the value a lot.
- `gh search` indexing lag (~seconds to ~1 min) is acceptable at a 300 s interval; document it so nobody files "missed a PR for 30 seconds" bugs.
