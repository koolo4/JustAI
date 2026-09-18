# JustAI Architecture

## Current Version

0.2.0

---

# Architecture

JustAI построен по модульной архитектуре.

Каждый модуль является независимой единицей и содержит собственные:

- Routes
- Controller
- Service
- DTO
- Validators
- Types

Инфраструктурные сервисы располагаются отдельно и могут использоваться любым модулем.


Application
│
├── App
├── Container
├── Server
│
├── Core
│ ├── Config
│ ├── Logger
│ ├── Errors
│ ├── Validation
│ ├── Middleware
│ └── Events
│
├── Infrastructure
│ └── FileSystem
│
└── Modules
├── Workspace
├── AI
├── Terminal
├── Editor
└── ...


---

# Frozen Modules

## Core Module

Version: 1.0

Status: ✅ Frozen

Freeze Date: 25.07.2026

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

Version: 1.0

Status: ✅ Frozen

Freeze Date: 25.07.2026

### Components

- LocalFileSystem
- DirectoryScanner
- IgnoreService
- PathResolver

### Freeze Rules

Разрешено:

- исправление ошибок;
- оптимизация реализации.

Запрещено:

- изменение публичного API инфраструктурных сервисов;
- изменение формата возвращаемых данных без необходимости.

---

## Workspace Module

Version: 1.0

Status: ✅ Frozen

Freeze Date: 25.07.2026

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

Каждый модуль проходит одинаковые стадии разработки.


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