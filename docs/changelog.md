# Changelog

## Unreleased — Phase 1: Agent Runtime (21.10.2026)

### Added

- `server/src/modules/agent`: new agent runtime.
  - Internal message format with tool_use ids, raw JSON tool input, tool_result with is_error (`@justai/shared`).
  - `AgentLoop`: append-only history, parallel read-only tools, tool errors returned to the model, abort with consistent history, budgets (steps / output tokens / wall time), max_tokens and refusal handling.
  - Providers on official SDKs with streaming: Anthropic (`claude-opus-5-5` by default, adaptive thinking, effort, prompt caching, eager tool input streaming, server-side fallbacks), OpenAI Responses API, scripted Mock.
  - Sessions persisted as JSONL in `.justai/sessions`, resumable after restart.
  - System prompt with environment, project rules (`JUSTAI.md` / `AGENTS.md` / `CLAUDE.md`) and project tree, frozen per session.
  - Tools: `read_file` (line numbers, paging), `list_dir`, `edit_file`, `write_file`, `word_read`, `word_edit`.
- REST `/api/agent/*` and agent events over WebSocket.
- Web: agent chat with streaming, tool cards, thinking, Stop, session history.
- npm workspaces, `@justai/shared`, GitHub Actions CI.

### Removed

- `server/src/modules/ai` and `/api/ai/*` (single-string prompt concatenation, first-tool-only handling).

### Changed

- vitest 5, vite 8, @vitejs/plugin-react 6.

## Unreleased — Phase 0 (21.10.2026)

### Security

- Server listens on `127.0.0.1` only; unknown `Host` headers and foreign `Origin`s are rejected.
- All `/api` requests and WebSocket upgrades require a per-start Bearer token (`AccessGuard`).
- Fixed workspace escape in `PathResolver` (sibling folders sharing the root prefix passed the check).
- Agent tools resolve paths via `resolveSafePath`: `.justai` is denied, `.git` is read-only, symlinks pointing outside are rejected.

### Removed

- Browser Council (Playwright automation of third-party chat web UIs), see ADR-005.
- Dead code: regex `Planner`, unused context/parser/tool services, empty placeholder files.

### Added

- `.gitignore`, restored `tsconfig.base.json`.
- Vitest test runner with real tests (`npm test`, `npm run typecheck`).
- `AGENTS.md` / `CLAUDE.md` and `docs/MASTER_PLAN.md`.

### Fixed

- `IgnoreService` now understands CRLF and `dir/` rules in `.gitignore`.

## 0.1.0 — 25.07.2026

### Added

- Core module:
  - ConfigService
  - ConsoleLogger
  - Error classes
  - Validation framework
  - ErrorHandlerMiddleware
  - EventBus
  - Workspace events

- Infrastructure module:
  - LocalFileSystem
  - PathResolver
  - DirectoryScanner
  - IgnoreService

- Workspace module:
  - Tree scanning
  - File reading
  - File saving
  - File creation
  - Folder creation
  - Path deletion
  - Path renaming
  - Path moving
  - Request validation
  - Workspace event publishing

- Application bootstrap:
  - Container
  - Server
  - App startup flow

- Documentation:
  - architecture.md
  - modules.md

### Changed

- Introduced modular architecture for the backend.
- Replaced direct `process.env` access with `ConfigService`.
- Replaced direct `console.log` usage with `ConsoleLogger`.
- Added centralized error handling through `ErrorHandlerMiddleware`.
- Added request validation for Workspace endpoints.
- Added event-driven communication inside Workspace via `EventBus`.

### Frozen

- Core module
- Infrastructure module
- Workspace module

### Fixed

- Workspace path handling.
- File creation and save behavior.
- Rename and move operations.
- Error responses for missing files and invalid requests.
- EventBus export and module integration issues.