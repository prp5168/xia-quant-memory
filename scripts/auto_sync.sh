#!/usr/bin/env bash
set -euo pipefail
cd /root/.openclaw/workspace/agents/weather-odds-bot

if [[ "${1:-}" == "--status" ]]; then
  git status --short
  exit 0
fi

commit_msg="sync: quant memory and data"
if [[ "${1:-}" == "--reason" ]]; then
  shift
  reason="${1:-}"
  if [[ -n "$reason" ]]; then
    commit_msg="sync: ${reason}"
  fi
fi

git add MEMORY.md memory/ RULES.md SOUL.md USER.md IDENTITY.md data/observe-log.jsonl data/forecast-log.jsonl data/watchlist.json data/portfolio.json scripts/ config/ TOOLS.md 2>/dev/null || true

if git diff --cached --quiet; then
  echo "No staged changes"
  exit 0
fi

git commit -m "$commit_msg" || true
git push origin master
