# Backend

## Current State

Backend is the server-side foundation of JustAI.

At this stage, the backend is responsible for:

- application bootstrap;
- dependency injection;
- HTTP server startup;
- centralized configuration;
- logging;
- validation;
- error handling;
- workspace API;
- internal event communication.

---

## Frozen Dependencies

The backend currently depends on three frozen modules:

### Core — Frozen
Contains:

- ConfigService
- ConsoleLogger
- AppError hierarchy
- Validation framework
- ErrorHandlerMiddleware
- EventBus
- Event base classes and handlers

### Infrastructure — Frozen
Contains:

- LocalFileSystem
- PathResolver
- DirectoryScanner
- IgnoreService

### Workspace — Frozen
Contains:

- WorkspaceController
- WorkspaceService
- WorkspaceRoutes
- DTOs
- Validators
- Workspace event publishing

---

## Backend Responsibilities

The backend layer currently owns:

- `App`
- `Container`
- `Server`

### App
Coordinates startup flow.

### Container
Creates and stores shared application dependencies.

### Server
Configures Express, middleware, routes, and HTTP startup.

---

## Current Architecture

```text
Application
│
├── App
├── Container
├── Server
│
├── Core (Frozen)
│   ├── Config
│   ├── Logger
│   ├── Errors
│   ├── Validation
│   ├── Middleware
│   └── Events
│
├── Infrastructure (Frozen)
│   └── FileSystem
│
└── Workspace (Frozen)
    ├── Controller
    ├── Service
    ├── Routes
    ├── DTO
    ├── Validators
    └── Workspace Events
    Current Goals

The current goal of Backend is to prepare the project for the next runtime layer:

WebSocket transport;
real-time event delivery;
event subscription inside server modules;
future integration with frontend and AI.
What Is Already Complete
centralized config loading;
structured logging;
global error handling;
workspace CRUD API;
request validation;
event bus foundation;
workspace event publishing;
modular dependency injection;
clean startup flow.
What Must Stay Stable

Since the following modules are frozen:

Core
Infrastructure
Workspace

their public contracts must not be broken.

Allowed changes:

bug fixes;
performance improvements;
backward-compatible extensions.

Not allowed:

breaking REST API changes;
DTO contract changes;
public service method changes;
event contract breaks in frozen modules.
Next Backend Step

The next step for Backend is:

create a WebSocket module;
subscribe it to Core Events;
forward workspace events to connected clients;
keep Workspace isolated from transport concerns.

This will make the backend event-driven without modifying frozen modules.