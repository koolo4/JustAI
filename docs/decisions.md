# Architecture Decisions

## ADR-001
Date: 25.07.2026

Title:
Core Module Frozen

Decision:
Core module is frozen as version 1.0.

Included components:
- ConfigService
- ConsoleLogger
- AppError
- BadRequestError
- ForbiddenError
- NotFoundError
- ValidationError
- InternalServerError
- Validator
- ValidationResult
- ErrorHandlerMiddleware
- Event
- EventBus
- IEventHandler

Reason:
Core became a stable foundation for configuration, logging, validation, error handling, and events.

Consequences:
- Existing public contracts in Core must not be broken.
- New functionality may only be added in a backward-compatible way.

---

## ADR-002
Date: 25.07.2026

Title:
Infrastructure Module Frozen

Decision:
Infrastructure module is frozen as version 1.0.

Included components:
- LocalFileSystem
- DirectoryScanner
- IgnoreService
- PathResolver

Reason:
File system infrastructure was fully implemented and tested as a stable dependency for higher-level modules.

Consequences:
- Existing infrastructure APIs must remain stable.
- Changes are allowed only for bug fixes and internal improvements.

---

## ADR-003
Date: 25.07.2026

Title:
Workspace Module Frozen

Decision:
Workspace module is frozen as version 1.0.

Included components:
- WorkspaceController
- WorkspaceService
- WorkspaceRoutes
- CreateFileDto
- CreateFolderDto
- SaveFileDto
- DeletePathDto
- RenamePathDto
- MovePathDto
- CreateFileValidator
- SaveFileValidator
- CreateFolderValidator
- DeletePathValidator
- RenamePathValidator
- MovePathValidator

Public API:
- GET /api/workspace/tree
- GET /api/workspace/file
- PUT /api/workspace/file
- POST /api/workspace/file
- POST /api/workspace/folder
- DELETE /api/workspace
- POST /api/workspace/rename
- POST /api/workspace/move

Reason:
Workspace was fully implemented, validated, event-enabled, and tested manually.

Consequences:
- Public Workspace API must not be changed.
- DTO contracts must remain stable.
- New behavior may only be added in a backward-compatible way.
- Existing validation and event publishing behavior must remain intact.

---

## ADR-004
Date: 25.07.2026

Title:
EventBus Adopted as Core Communication Layer

Decision:
EventBus is accepted as the internal event communication mechanism for the project.

Reason:
It provides a stable foundation for decoupled communication between modules such as Workspace, WebSocket, AI, and future services.

Consequences:
- Modules should communicate via events where possible.
- Direct coupling between independent modules should be avoided.
- Event contracts should be treated as part of the Core API.

## Frontend Architecture

Decision:

Frontend построен как отдельное приложение apps/web.

Responsibilities:

- UI rendering
- Workspace visualization
- WebSocket event display
- User interaction

Backend remains source of truth.

Frontend does not access filesystem directly.

---

## ADR-005
Date: 21.10.2026

Title:
Browser Council removed

Decision:
Playwright automation of chatgpt.com, claude.ai and deepseek web UIs is removed, together with `.justai/browser-profiles`.

Reason:
- Automating third-party chat web UIs violates their terms of service and risks account bans.
- Selectors break on every UI change of those sites.
- Logged-in browser profiles were stored inside the workspace and were readable by agent tools.

Consequences:
- The "council of models" idea moves to MASTER_PLAN task P5-03 and will use official provider APIs only.
- `playwright` stays as a dependency for the future local-UI verification tool (P3-03), which only opens localhost.