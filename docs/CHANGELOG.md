# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] — 2026-02-25 — Phase 1: 基础 Runtime

### Added

- **Project scaffold**: `package.json`, `tsconfig.json`, `.gitignore`, `README.md`
- **NotificationCenter** (`src/notification-center.ts`): Event queue with JSONL persistence, monotonic ULID IDs, async drain with timeout
- **Sandbox + Worker** (`src/sandbox.ts`, `src/sandbox-worker.ts`): Code execution sandbox via child process, persistent `ctx` namespace, console hijacking, JSON-line IPC protocol
- **BackgroundManager** (`src/background-manager.ts`): Named async task management with AbortController cancellation and `guardedRun` error auto-notification
- **MemoryStore** (`src/memory.ts`): SQLite + FTS5 full-text search with LIKE fallback for CJK, person profiles (merge-update), conversation logs, todo items, raw SQL
- **SceneManager** (`src/scene-manager.ts`): Scene registration and switching with L1/L2 type definitions
- **Scene type definitions**: `home.d.ts`, `telegram.d.ts`, `memory.d.ts`
- **Scene registry** (`src/scenes/index.ts`): Builtin scene registration from `.d.ts` files
- **Documentation**: `docs/scene-authoring.md`, `docs/CHANGELOG.md`
- **55 unit tests**, all passing

## [0.2.0] — 2026-02-25 — Phase 2: Agent Loop + LLM 集成

### Added

- **LLM Wrapper** (`src/llm.ts`): Unified API for Anthropic Claude and OpenAI-compatible endpoints, retry with exponential backoff, config from env/yaml
- **CodeAct Session Runner** (`src/session-runner.ts`): Multi-turn LLM→code→execute loop, response parsing, output truncation, notification checks, session transcripts
- **Main Orchestrator** (`src/main.ts`): Full lifecycle (init → bootstrap → event loop), sandbox crash detection with auto-restart, context assembly
- **System Prompt** (`system-prompt.md`): Agent instructions with CodeAct environment, behavioral principles, persona injection
- **Config** (`config.example.yaml`): Sample configuration with documented options
- **8 additional unit tests** (63 total)

## [0.3.0] — 2026-02-25 — Phase 3: 记忆与人格 + Phase 4 部分

### Added

- **Session Compaction** (`src/compaction.ts`): LLM-based extraction of summaries, facts, person updates, todos from session transcripts; auto-writes to all memory tables; agent-state.md management
- **Safety Module** (`src/safety.ts`): `MessageRateLimiter` (per-session and per-minute), 12 forbidden destructive methods, `sent-messages.jsonl` audit log
- **Compaction integration** in `src/main.ts`: runs after each session in the event loop
- **Error recovery** (Task 4.1): sandbox crash detection → auto-restart → bootstrap replay → events pushed back to queue
- **Configuration** (Task 4.3): `config.example.yaml` + `loadLLMConfig` with env > yaml > defaults priority
- **10 additional unit tests** (73 total)
