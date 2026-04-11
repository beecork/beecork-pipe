# Changelog

All notable changes to Beecork are documented here.

## [1.4.0] — 2026-04-11

### Changed
- **Unified channel architecture.** All channels (Telegram, WhatsApp, Discord, Webhook) now go through a single shared pipeline (`src/channels/pipeline.ts`) and use the same deterministic router (`src/projects/router.ts`). Previously Telegram had its own parallel LLM-based routing path (PipeBrain); now every channel behaves identically.
- **Smart routing is now deterministic and built-in.** Project-name detection, sticky user context (10-min window), learned pattern matching, and ambiguity disambiguation prompts. No LLM call, no latency, no cost.
- **Memory is now explicit-only.** Auto-extraction of memories from every session has been removed. Facts are written only via the `beecork_remember` MCP tool (which now dedupes on insert) or the knowledge markdown files (`~/.beecork/knowledge/*.md` and `<project>/.beecork/knowledge.md`).
- `projectScanPaths` moved from `config.pipe.projectScanPaths` to top-level `config.projectScanPaths`. Existing configs still load via a fallback read — no migration required.
- Added indices on `memories(content)` and `memories(tab_name, created_at)` for dedup and tab-scope lookups.

### Removed
- **Anthropic API key is no longer required.** Beecork previously needed one for PipeBrain's smart routing; now it uses only the user's Claude Pro/Max subscription via Claude Code. `@anthropic-ai/sdk` dependency removed.
- `src/pipe/` directory (PipeBrain LLM routing, goal evaluation + auto-follow-up loop, `PipeBrain.learn()` knowledge extraction).
- `src/memory/extractor.ts` (auto memory extraction — redundant with `beecork_remember`).
- `src/machines/` (multi-machine scaffolding — no dispatch logic ever existed).
- `approvalMode` + `approvalTimeoutMinutes` config fields (were non-functional stubs that silently fell through to `yolo` mode).
- `memory_compaction` system event stub.
- `beecork machines` CLI command and `beecork_machines` MCP tool.
- `/machines` slash command.
- `config.pipe` section and associated fields (`routingModel`, `complexModel`, `confidenceThreshold`, `maxFollowUps`, `anthropicApiKey`, `enabled`).
- `memory.enabled` config field.
- Stale "Recommended: Smart folder routing / Run: beecork pipe setup" message from setup wizard (the command never existed).

### Fixed
- Latent safety bug where `approvalMode: "strict"` would silently run in `yolo` mode with a warning log instead of blocking.
- Duplicate Anthropic API calls per Telegram message: previously up to three calls fired per message (routing + goal evaluation + learning); now zero.
- `beecork_remember` no longer creates duplicate rows when the same fact is remembered multiple times.

### Migration notes
- **Breaking config shape changes are backward-compatible via fallback reads.** If your `~/.beecork/config.json` has a `pipe` section, it will be ignored; `projectScanPaths` inside it is still read as a fallback, so project discovery continues working.
- **Auto-extracted memories from prior versions remain in the database.** They no longer accumulate, but they are still returned by `beecork recall` and `beecork memory list`. To clean them up: `sqlite3 ~/.beecork/memory.db "DELETE FROM memories WHERE source = 'auto'"`.
- **No action required** unless you were relying on the (never fully working) LLM routing for messages that didn't mention any project name. In that case, start your messages with `/tab <name>` or include the project name.

### Internal
- ~900 lines deleted, ~500 net line reduction.
- 214/214 unit tests pass. Zero orphan references to removed symbols.

## [1.3.0] — 2026-04-01

### Added
- Watchers — condition-based monitoring with automatic actions
- Knowledge base — `beecork knowledge` for stored knowledge across sessions
- Time machine — replay and inspect past sessions
- Community store — `beecork store` for browsing extensions
- Fast voice — optimized STT/TTS pipeline
- ESLint, CI pipeline, unit tests, type safety improvements
- Open-source documentation (CONTRIBUTING, CODE_OF_CONDUCT, SECURITY)

### Changed
- Renamed `cron` commands to `tasks` (backward-compatible aliases kept)

### Fixed
- 42 issues from comprehensive code audit
- 7 simplification fixes from code review

## [1.2.0] — 2026-03-31

### Added
- Computer use support — Claude can control mouse, keyboard, and screen via `beecork computer-use`
- Capability packs — `beecork enable email/calendar/github/notion/drive/web/database`
- Quick and full setup wizard modes

## [1.1.0] — 2026-03-31

### Added
- Media generation providers — DALL-E, Stable Diffusion, Runway, Kling, Veo, Nano Banana, Lyria, ElevenLabs Music, Recraft
- Smart project routing — auto-discovers git repos, routes messages to the right tab
- Channel setup in wizard and CLI
- Tool progress updates with escalating intervals
- Publish workflow for npm via GitHub Actions

### Removed
- Suno integration (no official API available)

## [1.0.0] — 2026-03-31

### Added
- Core daemon with always-on background service (launchd/systemd)
- Virtual tabs — persistent Claude Code sessions
- Telegram, WhatsApp, Discord, and webhook channels
- Pipe brain — intelligent message routing with goal tracking
- MCP server with 38 tools
- Task scheduling (cron, interval, one-time)
- Cross-session memory (global, project, tab scopes)
- Web dashboard
- Multi-machine awareness
- Multi-agent delegation
- Session handoff to terminal
- Community channel SDK
- Notifications (Pushover, ntfy, webhooks)
- Tab templates and system prompts
- Voice (STT via Whisper, TTS via OpenAI/ElevenLabs)
- `beecork doctor` diagnostics
- Interactive setup wizard

[1.3.0]: https://github.com/beecork/beecork/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/beecork/beecork/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/beecork/beecork/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/beecork/beecork/releases/tag/v1.0.0
