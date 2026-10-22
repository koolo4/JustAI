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

---

## ADR-006
Date: 21.10.2026

Title:
Free operation via OpenAI-compatible APIs and a planner/executor split, not via web chat UIs

Decision:
- Free and local models are supported through one OpenAI-compatible provider with presets (Ollama, LM Studio, OpenRouter, Groq, Gemini, GitHub Models, DeepSeek).
- Hybrid mode: a strong (cloud) model plans and reviews in the "planner" profile; a local model (Ollama) executes delegated steps via delegate_task.
- Automating web chat interfaces (ChatGPT, Claude, DeepSeek, Arena) is rejected again.

Reason:
- The terms of these services forbid automated access; Arena's terms (section 5) explicitly forbid programmatic access and bots, and sections 3.3-3.4 allow sharing submitted content with third-party model providers without confidentiality.
- Web UIs break on every change and add captchas and rate limits; an autonomous agent needs a stable API.
- Most free tiers and local servers speak the OpenAI Chat Completions protocol, so one adapter covers them.
- Small local models are weak planners but adequate executors of precise single steps; the planner receives the executor's real actions (from tool results), not only its narrative.

Consequences:
- delegate_task needs no approval itself; every executor action goes through the planner session's permission mode and restore point.
- Ollama must run with a large context (OLLAMA_CONTEXT_LENGTH=32768), otherwise prompts are truncated silently.
- Tool calling of small models is unreliable; the provider recognizes calls written as text and retries malformed ones.
## ADR-007
Date: 22.10.2026

Title:
Settings and API keys from the interface

Decision:
- Settings edited in the interface are stored in `.justai/settings.json` of the JustAI install folder and override `server/.env`. Only a whitelist of variables (providers, keys, models, reserves, executor, proxy) can be changed; generated from the provider presets.
- API keys are stored as plain text in that file (mode 600), the same protection level as `server/.env`. The OS keychain (keytar) was rejected: the package is archived and needs a native build.
- The server never returns a key: only "set" and the last 4 characters. An empty key field in the interface means "keep".
- Saving rebuilds the server container in the same process (as switching the project folder); refused with 409 while an agent is running.

Consequences:
- `.justai/` must stay out of git and closed to agent file tools (as before). `run_command` can still read the file, as it could read `server/.env`; child processes do not inherit secret variables.
