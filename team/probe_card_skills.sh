#!/usr/bin/env bash
# probe_card_skills.sh — one pass over every card on a board: does each card's own
# skill list actually resolve for that card's assignee?
#
#   usage: bash team/probe_card_skills.sh <board-slug> [--plan]
#
#   --plan   print the per-card matrix and exit; no model calls (instant, free)
#
# A card naming a skill its assignee cannot resolve does not spawn: the worker dies
# with `agent failed: Unknown skill(s): <name>`. `-s <skill>` fails before any
# model call, so a MISSING line costs nothing.
#
# exit 0 only when every skill on every card RESOLVED. Verdict is COUNTS
# (RESOLVED == lines, MISSING == 0) — never the exit status of a probe.
# owner: hr-bot (profiles/*/config.yaml + TEAM_ROSTER_OFFENSE.md)
set -u
BOARD="${1:?usage: probe_card_skills.sh <board-slug> [--plan]}"
MODE="${2:-}"
H=hermes

mapfile -t ROWS < <("$H" kanban --board "$BOARD" list --json 2>/dev/null | python -c '
import sys, json
for t in json.load(sys.stdin):
    for s in (t.get("skills") or []) or [""]:
        print("\t".join([t["id"], t.get("status",""), t.get("assignee",""), s]))
')
if [ "${#ROWS[@]}" -eq 0 ]; then echo "no cards (or no parse) on board '$BOARD'"; exit 2; fi

res=0; miss=0; other=0; cards=0; last=""
for row in "${ROWS[@]}"; do
  IFS=$'\t' read -r id status seat skill <<<"$row"
  if [ "$id" != "$last" ]; then cards=$((cards+1)); last="$id"
    printf '\n%-11s %-9s %s\n' "$id" "$status" "$seat"; fi
  if [ -z "$skill" ]; then printf '  (no skills on card)\n'; continue; fi
  if [ "$MODE" = "--plan" ]; then printf '  planned   %s\n' "$skill"; res=$((res+1)); continue; fi
  out=$("$H" -p "$seat" -s "$skill" -z "Reply with exactly: SKILL-OK" 2>&1)
  case "$out" in
    *SKILL-OK*)          printf '  RESOLVED  %s\n' "$skill"; res=$((res+1)) ;;
    *"Unknown skill"*)   printf '  MISSING   %s   <- card will not spawn\n' "$skill"; miss=$((miss+1)) ;;
    *)                   printf '  OTHER     %s :: %s\n' "$skill" "$(printf '%s' "$out" | tail -1 | tr -d '\r' | cut -c1-70)"; other=$((other+1)) ;;
  esac
done

printf '\n--- board %s: %d cards, %d probes: %d RESOLVED / %d MISSING / %d OTHER ---\n' \
  "$BOARD" "$cards" "$((res+miss+other))" "$res" "$miss" "$other"
[ "$miss" -eq 0 ] && [ "$other" -eq 0 ]
