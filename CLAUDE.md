# Beecork — Developer Guide

## Publishing to npm

Publishing is handled by a GitHub Actions workflow (`.github/workflows/publish.yml`). Pushing code alone does NOT publish — the publish workflow is manually triggered via `workflow_dispatch` after CI passes green on the push.

**Pushing to GitHub does NOT update npm.** Users running `npm install -g beecork` get whatever version was last explicitly published via the workflow.

### Release workflow

```bash
# 1. Commit and push your changes
git add -A
git commit -m "..."
git push origin main

# 2. Wait for CI to pass (lint + test + build on Node 24)
gh run watch

# 3. Trigger the publish workflow (handles bump + build + publish + tag)
gh workflow run publish.yml -f version_bump=patch   # or minor / major / none
gh run watch
```

The publish workflow runs `npm test`, `npm run build`, `npm version <bump>`, `npm publish` (with `NPM_TOKEN` secret), and `git push && git push --tags` — in that order. You do not need to run `npm version` or `npm publish` locally.

### When to publish

Publish after any code changes that affect runtime behavior (bug fixes, new features, security fixes). No need to publish for docs-only or test-only changes.

### Choosing the bump

- `patch` — bug fixes, docs, internal refactors that don't change user-visible behavior
- `minor` — new features, behavior changes, config shape changes that are backward-compatible via fallback reads
- `major` — deliberate breaking changes that require users to update their configs or usage

## Project Structure

- `src/` — TypeScript source (~100 files)
- `dist/` — Compiled JS (built via `npm run build`)
- `tests/unit/` — Vitest unit tests
- `audits/` — Code audit reports (gitignored)

## Key Commands

```bash
npm run build        # TypeScript compile
npm run dev:daemon   # Run daemon in dev mode (tsx)
npm test             # Run vitest
npm run lint         # ESLint
```

## Architecture

```
CLI (Commander)          Daemon (always-on)
                              |
                         TabManager
                              |
                         ClaudeSubprocess (per tab, spawned on demand)
                              |
                         MCP server (child of claude, shared SQLite + signal files)
```

All channels (Telegram, WhatsApp, Discord, Webhook) feed messages into a single shared pipeline at `src/channels/pipeline.ts`, which calls the deterministic router at `src/projects/router.ts`. The router picks a tab based on (1) explicit `/tab <name>` override, (2) project-name detection in the message, (3) sticky user context (10-min window), (4) learned pattern matching from the `routing_preferences` table, (5) disambiguation prompt for ambiguous matches, (6) category keywords, (7) fallback to `general`.

No LLM is involved in routing. No Anthropic API key is required. Claude Code itself (spawned as a subprocess) uses the user's Claude Pro/Max subscription, not an API key.

## Conventions

- All notifications go through `broadcastNotify()` in daemon.ts — never couple directly to a specific channel
- Tab name validation is centralized in `TabManager.ensureTab()` via `validateTabName()`
- Shared text utilities (chunkText, timeAgo, parseTabMessage) live in `src/util/text.ts`
- Version is read from package.json via `src/version.ts` — never hardcode version strings
- Config file (`~/.beecork-pipe/config.json`) is chmod 600 after write (contains Telegram/Discord tokens)
- MCP server uses a cached singleton DB connection — not per-call
- Every channel calls `processInboundMessage()` from `src/channels/pipeline.ts` — no channel-specific routing code

## Subprocess environment

`ClaudeSubprocess` spawns `claude` with `env: { ...process.env }` — the subprocess inherits the daemon's **entire** environment. That includes anything in your shell profile: `OPENAI_API_KEY`, `GITHUB_TOKEN`, `AWS_ACCESS_KEY_ID`, `SSH_AUTH_SOCK`, etc.

Combined with `--dangerously-skip-permissions`, this means any prompt-injected Claude run inside Beecork can read those values (e.g. `bash -c 'printenv'`) and use them to call other services on your behalf. The 2026-05-15 audit fix tightened the most direct exfiltration path (`beecork_send_media` now refuses to upload files outside `~/.beecork-pipe/media/`), but the broader rule still applies: **treat any env var the daemon can see as also visible to every Claude subprocess.**

If you want to scrub specific keys, do it in the shell that launches the daemon, not at Claude-spawn time — there's no `envAllowlist` setting today.

## Log level

`BEECORK_LOG_LEVEL=debug beecork-pipe start` surfaces every `logger.debug` line (subprocess stdout/stderr, MCP non-JSON, etc.). Default is `info`. Useful when debugging "claude exits with no message" — at default level, `claude` stderr is logged at `warn` and reaches `daemon.log`, but `debug` adds the raw stdout parse failures.
