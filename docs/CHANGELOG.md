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
