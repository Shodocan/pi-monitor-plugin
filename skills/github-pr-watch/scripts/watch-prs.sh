#!/usr/bin/env bash
# watch-prs.sh — poll GitHub for PRs awaiting your review; emit PI_EVENT lines.
#
# Reference implementation of the watcher protocol (PLAN.md §3.4, §3.5):
#   - stdout carries ONLY protocol lines: `PI_EVENT {single-line JSON}`
#   - heartbeats / debug / gh noise go to stderr
#   - zero-secret: all auth is ambient `gh` auth; nothing is read or stored
#   - state (seen PR node ids) lives in ${XDG_STATE_HOME:-~/.local/state}/pi-monitor/
#
# Usage:
#   watch-prs.sh [--interval 300] [--repo owner/name ...] [--include-drafts]
#                [--include-bots] [--once]
#
# Designed for: /monitor --regex '^PI_EVENT ' -- watch-prs.sh --interval 300
set -euo pipefail

INTERVAL=300 ONCE=0 INCLUDE_DRAFTS=false INCLUDE_BOTS=false
REPOS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --interval) INTERVAL="$2"; shift 2 ;;
    --repo) REPOS+=("$2"); shift 2 ;;
    --include-drafts) INCLUDE_DRAFTS=true; shift ;;
    --include-bots) INCLUDE_BOTS=true; shift ;;
    --once) ONCE=1; shift ;;
    *) echo "watch-prs: unknown argument: $1" >&2; exit 2 ;;
  esac
done

emit() { printf 'PI_EVENT %s\n' "$1"; }
fail() { emit "$(jq -cn --arg m "$1" '{v:1,type:"error",message:$m}')"; exit 1; }

command -v jq >/dev/null 2>&1 || { echo 'PI_EVENT {"v":1,"type":"error","message":"jq is required"}'; exit 1; }
command -v gh >/dev/null 2>&1 || fail "gh CLI is required"
gh auth status >/dev/null 2>&1 || fail "gh auth required — run: gh auth login"

# Scope slug: "all" for cross-repo, else sorted repo list (owner/name -> owner__name)
if [[ ${#REPOS[@]} -eq 0 ]]; then
  SCOPE="all"
else
  SCOPE=$(printf '%s\n' "${REPOS[@]}" | sort | tr '/' '_' | paste -sd'-' -)
fi
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/pi-monitor/watch-prs"
STATE_FILE="$STATE_DIR/$SCOPE.json"
mkdir -p "$STATE_DIR"

REPO_ARGS=()
for r in "${REPOS[@]:-}"; do [[ -n "$r" ]] && REPO_ARGS+=(--repo "$r"); done

poll() {
  local now results events new_events current_ids
  now=$(date +%s)

  if ! results=$(gh search prs --review-requested=@me --state=open \
      --json id,number,title,url,repository,author,isDraft,updatedAt \
      --limit 50 ${REPO_ARGS[@]+"${REPO_ARGS[@]}"} 2>>/dev/stderr); then
    echo "[watch-prs] gh search failed; will retry next interval" >&2
    return 0
  fi

  # Filter drafts/bots, shape protocol events (title capped at 120 chars).
  events=$(jq -c --argjson drafts "$INCLUDE_DRAFTS" --argjson bots "$INCLUDE_BOTS" '
    .[]
    | select($drafts or (.isDraft | not))
    | select($bots or ((.author.type == "Bot" or (.author.login | endswith("[bot]"))) | not))
    | {v:1, type:"pr_review_requested", id, repo:.repository.nameWithOwner,
       number, title:(.title[0:120]), url, author:.author.login,
       bot:(.author.type == "Bot" or (.author.login | endswith("[bot]"))),
       draft:.isDraft, updatedAt}' <<<"$results")

  current_ids=$(jq -cs 'map(.id)' <<<"$events")

  if [[ ! -f "$STATE_FILE" ]]; then
    # First run: seed state, emit one baseline instead of N stale events.
    emit "$(jq -cn --arg scope "$SCOPE" --argjson n "$(jq -s 'length' <<<"$events")" \
      '{v:1,type:"baseline",count:$n,scope:$scope}')"
  else
    new_events=$(jq -c --slurpfile st "$STATE_FILE" \
      'select(($st[0].seen[.id] // null) == null)' <<<"$events")
    while IFS= read -r line; do
      [[ -n "$line" ]] && emit "$line"
    done <<<"$new_events"
  fi

  # Persist AFTER emitting (at-least-once). Prune ids unseen for >7 days so a
  # re-requested review fires again.
  jq -cn --argjson now "$now" --argjson cur "$current_ids" \
    --slurpfile st <(cat "$STATE_FILE" 2>/dev/null || echo '{}') '
    (($st[0].seen // {}) | with_entries(select($now - .value < 604800))) as $kept
    | {version:1, lastPoll:$now,
       seen: ($kept + ($cur | map({key:., value:$now}) | from_entries))}' \
    > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"

  echo "[watch-prs] polled $SCOPE: $(jq -s 'length' <<<"$events") open, state at $STATE_FILE" >&2
}

poll
[[ "$ONCE" -eq 1 ]] && exit 0
while sleep "$INTERVAL"; do poll; done
