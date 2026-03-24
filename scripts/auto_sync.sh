#!/usr/bin/env bash
set -euo pipefail
cd /root/.openclaw/workspace/agents/weather-odds-bot

if [[ "${1:-}" == "--status" ]]; then
  git status --short
  exit 0
fi

git add MEMORY.md memory/ RULES.md SOUL.md USER.md IDENTITY.md data/observe-log.jsonl data/forecast-log.jsonl data/watchlist.json data/portfolio.json scripts/ 2>/dev/null || true

if git diff --cached --quiet; then
  echo "No staged changes"
  exit 0
fi

git commit -m "sync: quant memory and data" || true
git push origin master
