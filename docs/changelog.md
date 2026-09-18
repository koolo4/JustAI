# Changelog

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