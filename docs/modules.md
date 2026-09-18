# JustAI Modules

## Project Version

Current Version: **0.1.0**

Last Updated: **25.07.2026**

---

Frontend
Version: 0.1
Status: 🚧 In Progress

Implemented:
- React shell
- Workspace tree
- File viewer
- File saving
- WebSocket events

Next:
- Editor improvements
- File operations UI
- Terminal integration

# Module Status

| Module | Version | Status | Tests | Frozen | Notes |
|---------|---------|--------|--------|---------|-------|
| Core | 1.0 | ✅ Ready | ✅ | ✅ | Config, Logger, Errors, Validation, Middleware, Events завершены |
| Infrastructure | 1.0 | ✅ Ready | ✅ | ✅ | FileSystem полностью реализован |
| Workspace | 1.0 | ✅ Ready | ✅ | ✅ | Полностью реализован и протестирован |
| Backend | 0.2 | 🚧 In Progress | ⏳ | ❌ | Подготовка к WebSocket |
| Frontend | 0.0 | ⏳ Planned | ❌ | ❌ | Не начат |
| WebSocket | 0.0 | ⏳ Planned | ❌ | ❌ | Следующий этап разработки |
| AI | 0.0 | ⏳ Planned | ❌ | ❌ | Не начат |
| Terminal | 0.0 | ⏳ Planned | ❌ | ❌ | Не начат |
| Editor | 0.0 | ⏳ Planned | ❌ | ❌ | Не начат |
| Search Engine | 0.0 | ⏳ Planned | ❌ | ❌ | Индексация проекта |
| Plugin System | 0.0 | ⏳ Planned | ❌ | ❌ | Расширения JustAI |

---

# Frozen Modules

## Core Module

Version: **1.0**

Freeze Date: **25.07.2026**

### Components

#### Config

- ConfigService

#### Logger

- ILogger
- ConsoleLogger

#### Errors

- AppError
- BadRequestError
- ForbiddenError
- NotFoundError
- ValidationError
- InternalServerError

#### Validation

- Validator
- ValidationResult

#### Middleware

- ErrorHandlerMiddleware

#### Events

- Event
- EventBus
- IEventHandler
- Workspace events

### Freeze Rules

Разрешено:

- исправление ошибок;
- оптимизация производительности;
- добавление новых компонентов без изменения существующих контрактов.

Запрещено:

- изменение интерфейса ILogger;
- изменение структуры AppError;
- изменение ValidationResult;
- изменение базового Validator;
- изменение публичного API ConfigService;
- изменение контракта EventBus;
- изменение базового Event.

---

## Infrastructure Module

Version: **1.0**

Freeze Date: **25.07.2026**

### Components

- LocalFileSystem
- DirectoryScanner
- IgnoreService
- PathResolver

### Status

Frozen

---

## Workspace Module

Version: **1.0**

Freeze Date: **25.07.2026**

### Components

#### Infrastructure

- LocalFileSystem
- DirectoryScanner
- IgnoreService
- PathResolver

#### DTO

- CreateFileDto
- CreateFolderDto
- SaveFileDto
- DeletePathDto
- RenamePathDto
- MovePathDto

#### Validators

- CreateFileValidator
- SaveFileValidator
- CreateFolderValidator
- DeletePathValidator
- RenamePathValidator
- MovePathValidator

#### Controller

- WorkspaceController

#### Service

- WorkspaceService

#### Routes

- WorkspaceRoutes

### Frozen API

GET /api/workspace/tree

GET /api/workspace/file

PUT /api/workspace/file

POST /api/workspace/file

POST /api/workspace/folder

DELETE /api/workspace

POST /api/workspace/rename

POST /api/workspace/move

### Freeze Rules

Разрешено:

- исправление ошибок;
- оптимизация;
- добавление новой функциональности без изменения существующего API.

Запрещено:

- изменение DTO;
- изменение существующих REST endpoints;
- изменение публичных методов WorkspaceService;
- изменение структуры ответов API;
- изменение контрактов валидаторов.

---

# Modules In Development

## Backend

Current Goal:

- Подготовка инфраструктуры для WebSocket
- Расширение DI Container
- Подготовка событийной модели

---

# Planned Order

1. ✅ Core
2. ✅ Infrastructure
3. ✅ Workspace
4. 🚧 Backend
5. WebSocket
6. AI
7. Terminal
8. Search Engine
9. Editor
10. Frontend
11. Plugin System

---

# Module Lifecycle

Planning

↓

Development

↓

Testing

↓

Documentation

↓

Frozen

После получения статуса **Frozen** публичный контракт модуля считается стабильным.

Новая функциональность добавляется только через расширение модуля без изменения существующего API.

---

# Statistics

Frozen Modules: **3**

Modules In Development: **1**

Planned Modules: **7**