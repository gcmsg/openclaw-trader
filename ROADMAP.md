# Roadmap

> openclaw-trader development roadmap. Items are ordered by priority within each phase.

---

## v0.2 — Execution Reliability

- [ ] **Unified MTF filter** — Extract duplicated MTF trend filtering from `monitor.ts` / `live-monitor.ts` into a shared `checkMtfTrend()` function
- [ ] **Activate Protection Manager** — Pass `recentTrades` from `signal-history.jsonl` into `processSignal()` to enable cooldown / stoploss_guard / max_drawdown protections
- [ ] **Short staged take-profit** — Initialize `tpStages` for short positions (currently only long positions get staged TP)
- [ ] **Spot market short signal guard** — Pre-filter `short` signals at the signal detection layer for `spot` market type, avoiding misleading notifications
- [ ] **Regime confidence config** — Expose the hardcoded `60` confidence threshold as `regime_confidence_threshold` in YAML

## v0.3 — Observability & Dashboard

- [ ] **Web dashboard auth** — Add basic authentication to `dashboard-server.ts` before production use
- [ ] **Telegram bot as standalone** — Run `telegram-bot.ts` as a persistent process alongside the monitor
- [ ] **Filtered signal logging** — Log signals rejected by MTF / sentiment gate with rejection reason for post-analysis
- [ ] **Real-time equity tracking** — Persist equity snapshots at regular intervals for charting

## v0.4 — Strategy & Intelligence

- [ ] **Kelly position sizing activation** — Switch from fixed sizing to half-Kelly after accumulating 30+ closed trades
- [ ] **Walk-forward scheduling** — Run `auto-wf.ts` on a regular cron schedule to keep parameters fresh
- [ ] **LLM sentiment enrichment** — Improve OpenClaw Gateway integration for deeper market narrative analysis
- [ ] **Options flow integration** — Incorporate put/call ratio and open interest changes into signal weighting
- [ ] **On-chain metrics** — Whale wallet tracking, exchange inflow/outflow signals

## v0.5 — Multi-Exchange & Scaling

- [ ] **Exchange abstraction layer** — Decouple from Binance-specific APIs to support OKX, Bybit, etc.
- [ ] **Multi-account support** — Run separate strategy instances across multiple exchange accounts
- [ ] **Docker deployment** — Official `Dockerfile` + `docker-compose.yml` for one-command deployment
- [ ] **Cloud-native cron** — Replace system crontab with internal scheduler for containerized environments

## Future Ideas

- WebSocket-only mode (replace REST polling for sub-second latency)
- Grid / DCA strategy plugins
- Portfolio rebalancing strategy
- Backtesting UI (web-based interactive charts)
- Strategy marketplace (share/import YAML + plugin bundles)

---

*This roadmap reflects current priorities and may evolve based on community feedback and usage patterns.*
