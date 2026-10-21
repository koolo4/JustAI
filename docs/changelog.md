# Changelog

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