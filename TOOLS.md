# TOOLS.md - Local Notes

## GitHub Sync
- Repo: `git@github.com:prp5168/xia-quant-memory.git`
- Branch: `master`
- Auto-sync script: `scripts/auto_sync.sh`
- Sync policy doc: `config/quant_sync_policy.md`
- Daily fallback sync: 23:55 (Asia/Shanghai)
- Immediate sync command:
  - `./scripts/auto_sync.sh --reason "logic update"`
  - `./scripts/auto_sync.sh --reason "strategy change"`
  - `./scripts/auto_sync.sh --reason "rule update"`
- Sync scope: MEMORY.md, memory/, RULES.md, SOUL.md, USER.md, IDENTITY.md, data/observe-log.jsonl, data/forecast-log.jsonl, data/watchlist.json, data/portfolio.json, scripts/, config/, TOOLS.md

## 项目提醒
- 虾量化是项目型 bot，详细项目记忆优先保留在本 bot 工作区。
- 平台级摘要归档由虾记负责，不替代本 bot 的项目原始记忆。
- 原则：日终自动同步 + 关键变更即时同步。
