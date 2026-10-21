# JustAI — Master Plan

> **Назначение документа.** Это единый источник правды о том, *что* мы строим, *как* устроена целевая архитектура и *в каком порядке* делать работу. Документ написан так, чтобы по нему могли работать и люди, и ИИ-агенты (Claude, GPT, Cursor и т.д.).
>
> **Правило для любого агента:** перед началом работы прочитай разделы 1–4 и 9, затем найди в разделе 7 первую задачу со статусом `TODO`, у которой выполнены все зависимости. Работай только над ней. По завершении обнови её статус и раздел 11 («Журнал»).

Версия плана: 1.0 · Дата: 2026-10-21 · Текущая версия продукта: 0.2.0

---

## Содержание

1. Видение продукта
2. Принципы и нерушимые правила
3. Текущее состояние (аудит 0.2.0)
4. Целевая архитектура
5. Ключевые контракты (типы и интерфейсы)
6. Модель безопасности и разрешений
7. План работ по фазам (задачи с критериями готовности)
8. Стратегия тестирования
9. Протокол работы для ИИ-агентов
10. Риски и открытые вопросы
11. Журнал выполнения

---

## 1. Видение продукта

**JustAI** — локальная автономная среда разработки с ИИ-агентом, сопоставимая с Cursor / Claude Code. Агент работает на ПК пользователя и умеет:

- понимать проект: структура, стек, правила, история;
- писать и редактировать код в нескольких файлах;
- **сам запускать** сборку, тесты, линтеры и dev-серверы и читать их вывод;
- **сам проверять** результат: тесты зелёные, типы сходятся, UI открывается в браузере без ошибок в консоли;
- писать документацию и changelog;
- работать долго (десятки и сотни шагов) в рамках бюджета, с возможностью паузы, отмены и отката;
- показывать каждый шаг в UI: мысли/план, вызовы инструментов, диффы, вывод терминала.

**Целевой сценарий («north star»):**
> Пользователь пишет: «Добавь в проект X эндпоинт /users с пагинацией, покрой тестами и обнови README». Агент составляет план, читает нужные файлы, вносит правки, запускает `npm test`, чинит упавшие тесты, запускает typecheck, обновляет README и выдаёт отчёт с диффом. Пользователь нажимает «Принять» или «Откатить всё».

**Что НЕ является целью (non-goals) на ближайшие версии:**
- облачный SaaS и многопользовательский режим;
- автоматизация веб-интерфейсов ChatGPT/Claude/DeepSeek (нарушает ToS, хрупко; см. задачу P0-06);
- собственная LLM.

---

## 2. Принципы и нерушимые правила

1. **Сначала ядро, потом интеграции.** Пока не работает цикл «правка → запуск → проверка», новые интеграции (Word, Google, Slack) не добавляются.
2. **Агент проверяет себя сам.** Задача не считается выполненной агентом, пока он не запустил проверку (тесты/typecheck/build) или явно не сообщил, почему это невозможно.
3. **Безопасность по умолчанию.** Любое действие с побочными эффектами за пределами workspace или необратимое действие требует разрешения (раздел 6).
4. **Всё обратимо.** Перед правками агента делается снапшот; у каждой сессии есть «Откатить всё».
5. **Честность.** Агент не сообщает об успехе, если инструмент вернул ошибку. Ошибки инструментов возвращаются модели, а не скрываются.
6. **Провайдеро-независимость.** Ядро работает с внутренним форматом сообщений; Anthropic/OpenAI/локальные модели — адаптеры.
7. **Backend — источник правды.** Фронт не трогает файловую систему напрямую; всё идёт через API/WebSocket.
8. **Маленькие проверяемые шаги.** Каждая задача плана заканчивается работающим состоянием и проходящими тестами.
9. **Модули не «замораживаются»** до версии 1.0 продукта. Контракты документируются, но могут меняться через ADR в `docs/decisions.md`.

---

## 3. Текущее состояние (аудит 0.2.0)

### 3.1 Что есть

| Область | Состояние |
|---|---|
| Сервер | Express + ручной DI (`server/src/app/Container.ts`), EventBus, валидаторы, ошибки |
| Workspace API | CRUD файлов/папок, дерево, события → WebSocket |
| AI | `AIService` с циклом до 12 шагов, профили агентов (general/coder/office) |
| Инструменты | `read_file`, `list_files`, `edit_file`, `word_read`, `word_edit` |
| Провайдеры | Anthropic, OpenAI (Responses API), Mock — через ручной `fetch` |
| Интеграции | Microsoft OAuth + Graph + .docx |
| Browser Council | Playwright-автоматизация chatgpt.com / claude.ai / deepseek |
| Фронт | React + Vite: дерево файлов, просмотр файла, чат, консоль событий |
| Тесты | 4 теста инфраструктуры, без настроенного раннера |

### 3.2 Известные проблемы (обязательны к исправлению)

| # | Проблема | Где | Задача |
|---|---|---|---|
| A1 | Нет `.gitignore`; `repomix-output.txt` в git | корень | P0-01 |
| A2 | `tsconfig.base.json` отсутствует, сборка сервера сломана | `server/tsconfig.json` | P0-02 |
| A3 | Нет тест-раннера; рядом с тестами лежат скомпилированные `.js/.d.ts/.map` | `server/tests` | P0-03 |
| A4 | `cors()` без ограничений и без аутентификации — любой сайт может управлять агентом | `server/src/app/Server.ts` | P0-04 |
| A5 | `PathResolver` проверяет вложенность через `startsWith` (обход через `JustAI-evil`) | `server/src/infrastructure/filesystem/PathResolver.ts` | P0-05 |
| A6 | Профили браузера с cookie лежат внутри workspace (`.justai/browser-profiles`) и доступны `read_file` | `BrowserCouncilService` | P0-06 |
| A7 | История агента склеивается в одну строку; нет `tool_result` с id | `AIService.ts` | P1-* |
| A8 | Обрабатывается только первый `tool_use`; аргументы приводятся к строкам | провайдеры | P1-* |
| A9 | Ошибка инструмента бросает исключение и роняет запрос | `ToolExecutor.ts` | P1-04 |
| A10 | `edit_file` пишет в обход `WorkspaceService` → UI не узнаёт об изменениях | `EditFileTool.ts` | P2-01 |
| A11 | Мёртвый код: `Planner` (regex), пустые файлы-заглушки | разное | P0-07 |
| A12 | Устаревшие модели по умолчанию | провайдеры, `.env.example` | P1-03 |

---

## 4. Целевая архитектура

### 4.1 Общая схема

```
┌──────────────────────────── apps/web (React + Vite, позже Electron/Tauri) ────────────────────────────┐
│  FileTree │ Monaco Editor │ DiffReview │ AgentTimeline │ Terminal (xterm.js) │ Chat │ Settings          │
└───────────────▲──────────────────────────────▲───────────────────────────────────────────────────────┘
                │ REST (команды)                │ WebSocket (стрим событий сессии, файлов, терминала)
┌───────────────┴──────────────────────────────┴─────────── server (Node 22 + TS) ─────────────────────┐
│  HTTP/WS Gateway  ── auth-токен, Origin-whitelist, bind 127.0.0.1                                      │
│                                                                                                        │
│  ┌───────────── Agent Runtime ─────────────┐   ┌──────── Tools ────────┐   ┌──── Services ─────────┐  │
│  │ SessionManager (создать/продолжить)      │   │ fs: read/write/edit   │   │ WorkspaceService      │  │
│  │ AgentLoop (model ⇄ tools, бюджеты)       │──▶│ search: glob/grep     │──▶│ ProcessManager        │  │
│  │ ContextManager (компакция, кэш)          │   │ shell: run/output/kill│   │ GitService/Snapshots  │  │
│  │ PermissionGate (ask/auto/deny)           │   │ git: status/diff/...  │   │ ProjectDetector       │  │
│  │ SubagentRunner                           │   │ browser: open/shot    │   │ BrowserService (PW)   │  │
│  │ EventEmitter → WS                        │   │ todo, subagent, docs  │   │ MemoryStore / Index   │  │
│  └──────────────────┬───────────────────────┘   └───────────────────────┘   └───────────────────────┘  │
│                     │                                                                                  │
│  ┌──────────────────▼──── Providers (адаптеры) ────────────────┐   ┌──── Storage (.justai/ вне git) ─┐ │
│  │ AnthropicProvider (@anthropic-ai/sdk, streaming, caching)    │   │ sessions/*.jsonl                │ │
│  │ OpenAIProvider (openai SDK)  │ OllamaProvider │ MockProvider │   │ snapshots, memory, settings     │ │
│  └──────────────────────────────────────────────────────────────┘   └─────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Структура каталогов (целевая)

```
server/src/
  app/                    Container, Server, App (как сейчас)
  core/                   config, logger, errors, events, validation (как сейчас)
  infrastructure/
    filesystem/           как сейчас + safePath()
    process/              ProcessManager (spawn, PTY, таймауты, kill дерева)
    git/                  GitService (через simple-git или child_process)
    browser/              BrowserService (Playwright, только localhost/разрешённые хосты)
  modules/
    workspace/            как сейчас
    agent/                ← НОВОЕ ядро (заменяет modules/ai по мере миграции)
      runtime/            AgentLoop, SessionManager, ContextManager, Budget
      messages/           внутренний формат сообщений (раздел 5.1)
      providers/          адаптеры провайдеров
      tools/              реализации инструментов, по файлу на инструмент
      permissions/        PermissionGate, правила, режимы
      prompts/            системный промпт, сборка контекста проекта
      project/            ProjectDetector, правила проекта (JUSTAI.md)
      memory/             долговременная память
      subagents/          SubagentRunner
    terminal/             REST/WS для пользовательского терминала
    integrations/         Microsoft и др. (позже, как плагины инструментов)
  tests/                  зеркало src/, Vitest
apps/web/src/
  features/agent/         AgentTimeline, ToolCallCard, PermissionDialog, DiffReview
  features/editor/        Monaco
  features/terminal/      xterm.js
  features/files/         FileTree
  services/, hooks/, types/
packages/shared/          общие типы событий WS и DTO (сервер ↔ фронт)
```

### 4.3 Поток одной задачи

1. Фронт: `POST /api/agent/sessions` → `{ sessionId }`, затем `POST /api/agent/sessions/:id/messages` с текстом пользователя.
2. `SessionManager` добавляет `UserMessage` и запускает `AgentLoop` (асинхронно; ответ HTTP — 202).
3. `AgentLoop`:
   1. `ContextManager` собирает запрос: системный промпт + правила проекта + история (с компакцией) + определения инструментов.
   2. Провайдер стримит ответ → события `assistant.delta` уходят в WS.
   3. Если в ответе есть `tool_use` блоки → для каждого `PermissionGate.check()` → (возможно ожидание ответа пользователя) → выполнение (параллельно для read-only, последовательно для мутирующих) → `ToolResult` блоки.
   4. Повтор, пока модель не вернёт ответ без инструментов, либо не исчерпан бюджет, либо пользователь не нажал «Стоп».
4. Все сообщения пишутся в `.justai/sessions/<id>.jsonl` (можно продолжить после перезапуска).
5. Перед первым мутирующим инструментом в сессии `SnapshotService` делает снапшот; в конце — событие `session.completed` с итоговым диффом.

---

## 5. Ключевые контракты (типы и интерфейсы)

> Эти типы кладутся в `packages/shared` (то, что видит фронт) и `server/src/modules/agent/messages` (внутреннее). Менять — только через ADR.

### 5.1 Внутренний формат сообщений

```ts
export type Role = "user" | "assistant";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string; signature?: string }        // для провайдеров, которые это поддерживают
  | { type: "tool_use"; id: string; name: string; input: unknown } // input — JSON как есть, без приведения к строкам
  | { type: "tool_result"; toolUseId: string; content: ToolOutput; isError: boolean }
  | { type: "image"; mediaType: string; dataBase64: string };     // скриншоты браузера

export interface Message {
  id: string;            // ulid
  role: Role;
  content: ContentBlock[];
  createdAt: string;     // ISO
  meta?: { model?: string; usage?: Usage; compacted?: boolean };
}

export type ToolOutput = string | Array<{ type: "text"; text: string } | { type: "image"; mediaType: string; dataBase64: string }>;

export interface Usage { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
```

### 5.2 Провайдер

```ts
export interface ModelRequest {
  system: SystemBlock[];             // блоки, чтобы можно было ставить cache breakpoints
  messages: Message[];
  tools: ToolDefinition[];
  maxOutputTokens: number;
  signal: AbortSignal;
}

export type ModelStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_use"; block: Extract<ContentBlock, { type: "tool_use" }> }
  | { type: "done"; message: Message; stopReason: "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other"; usage: Usage };

export interface ModelProvider {
  readonly id: string;                         // "anthropic" | "openai" | "ollama" | "mock"
  stream(req: ModelRequest): AsyncIterable<ModelStreamEvent>;
  countTokens?(req: Omit<ModelRequest, "signal">): Promise<number>;
  readonly capabilities: { parallelTools: boolean; images: boolean; promptCaching: boolean; contextWindow: number };
}
```

Правила для адаптеров:
- использовать официальные SDK (`@anthropic-ai/sdk`, `openai`), а не ручной `fetch`;
- ретраи с экспоненциальной задержкой для 429/5xx/overloaded;
- Anthropic: `cache_control` на последний блок системного промпта, на определения инструментов и на последнее сообщение истории;
- модели по умолчанию берутся из конфига; значения по умолчанию в `.env.example` — актуальные (с P1-03: `claude-opus-5-5` для основного цикла с `effort: high`, `claude-haiku-5-5` — кандидат для дешёвых сабагентов/компакции);
- ответы провайдера хранятся в `meta.providerRaw` и отправляются тому же провайдеру без изменений (thinking-блоки Opus 5.5 обязаны возвращаться нетронутыми; история только дополняется — никаких правок прошлых сообщений, это же условие кэширования);
- Anthropic: `eager_input_streaming` на инструментах + валидация входа zod в цикле; `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`) на случай отказа модели;
- реализация: `server/src/modules/agent/providers/`. Фактический контракт — `ModelProvider.ts` (без `capabilities`/`countTokens`, добавить при необходимости).

### 5.3 Инструмент

```ts
export interface ToolContext {
  sessionId: string;
  workspaceRoot: string;
  signal: AbortSignal;
  emit(event: AgentEvent): void;     // прогресс (например, стрим вывода команды)
  fs: SafeFs;                        // единственный способ трогать файлы — через WorkspaceService
  processes: ProcessManager;
  snapshots: SnapshotService;
}

export interface Tool<I = unknown> {
  name: string;                      // snake_case
  description: string;               // для модели: что делает, когда использовать, ограничения
  inputSchema: z.ZodType<I>;         // zod → JSON Schema для провайдера
  kind: "read" | "write" | "execute" | "network"; // для PermissionGate и параллельности
  run(input: I, ctx: ToolContext): Promise<ToolOutput>; // бросает ToolError → isError=true для модели
}
```

Правила для инструментов:
- вход валидируется zod-схемой; ошибка валидации возвращается модели как `isError`, а не роняет цикл;
- вывод обрезается до лимита (например, 30 000 символов) с пометкой «…truncated, use offset»;
- все пути проходят через `safePath()` (относительно workspace, с проверкой через `path.relative`, с разрешением симлинков через `realpath`);
- `read`-инструменты могут выполняться параллельно; `write`/`execute` — последовательно.

### 5.4 События сессии (WebSocket)

Реализовано (источник правды — `packages/shared/src/events.ts`):

```ts
export type AgentEvent =
  | { type: "session.status"; sessionId: string; status: SessionStatus; error?: string } // idle|running|completed|stopped|failed
  | { type: "assistant.delta"; sessionId: string; text: string }
  | { type: "assistant.thinking_delta"; sessionId: string; text: string }
  | { type: "message.added"; sessionId: string; message: Message }                       // без meta.providerRaw
  | { type: "tool.started"; sessionId: string; toolUseId: string; name: string; input: unknown }
  | { type: "tool.progress"; sessionId: string; toolUseId: string; chunk: string }      // stdout команды (P2-03)
  | { type: "tool.finished"; sessionId: string; toolUseId: string; isError: boolean; preview: string }
  | { type: "budget.updated"; sessionId: string; usage: Usage; steps: number }
  | { type: "file.changed"; sessionId: string; path: string; diff: string }              // P2-01
  | { type: "todo.updated"; sessionId: string; todos: Todo[] }                           // P2-06
  | { type: "permission.request"; sessionId: string; request: PermissionRequest }        // P2-04
  | { type: "permission.resolved"; sessionId: string; requestId: string; decision: PermissionDecision };
```

Итоговый дифф сессии отдаётся не событием, а запросом `GET /sessions/:id/changes` (P2-05).

### 5.5 REST API (агент)

Реализовано (типы — `packages/shared/src/api.ts`, подробности — `docs/api.md`):

```
GET    /api/agent/providers                    → { providers, defaultProvider }
GET    /api/agent/profiles                     → { profiles }
POST   /api/agent/sessions                     → 201 { session }         body: { profile?, provider?, model?, mode? }
GET    /api/agent/sessions                     → { sessions }
GET    /api/agent/sessions/:id                 → { session, messages, pendingPermissions, todos }
PATCH  /api/agent/sessions/:id                 → { session }             body: { mode }  (действует сразу)
POST   /api/agent/sessions/:id/messages        → 202 { session }         body: { text, activeFile? }   (409, если агент уже работает)
POST   /api/agent/sessions/:id/stop            → { session }
POST   /api/agent/sessions/:id/permissions/:requestId → 204   body: { decision: "allow" | "allow_always" | "deny", note? }
GET    /api/agent/sessions/:id/changes         → { available, files, diff }   изменения с момента первой правки
POST   /api/agent/sessions/:id/revert          → { files }   откат к снапшоту (409, если агент работает)
```

---

## 6. Модель безопасности и разрешений

### 6.1 Периметр сервера
- сервер слушает только `127.0.0.1`;
- при старте генерируется случайный токен (сохраняется в `.justai/runtime.json`, фронт получает его при загрузке с того же origin). Все REST/WS-запросы требуют `Authorization: Bearer <token>`;
- CORS: только origin фронта (`http://localhost:3000` и origin десктоп-оболочки);
- лимит размера тела запроса, rate limit на агентские эндпоинты.

### 6.2 Режимы агента

| Режим | read | write (внутри workspace) | execute | network / вне workspace |
|---|---|---|---|---|
| `ask` (по умолчанию) | авто | спросить | спросить | спросить |
| `auto-edit` | авто | авто | спросить (кроме allow-листа) | спросить |
| `full-auto` | авто | авто | авто (кроме deny-листа) | спросить |

### 6.3 Правила команд
- **allow по умолчанию** (в `auto-edit`): `npm test`, `npm run lint|typecheck|build`, `npx tsc --noEmit`, `pytest`, `git status|diff|log`, `ls`/`dir`, `node --version`;
- **deny всегда** (только явное подтверждение пользователя, даже в `full-auto`): `rm -rf`/`Remove-Item -Recurse` вне workspace, `git push`, `git reset --hard`, `format`, `shutdown`, изменения реестра/системных настроек, `curl | sh`, установка глобальных пакетов;
- правила хранятся в `.justai/permissions.json` (проект) и `~/.justai/permissions.json` (пользователь); «Разрешать всегда» дописывает правило.

### 6.4 Защита данных
- `.justai/` (сессии, токены, профили) — **вне** доступа файловых инструментов агента (жёсткий deny в `safePath`);
- `.env`, `*.pem`, `id_rsa*` — чтение только с разрешения; содержимое не логируется;
- содержимое файлов и вывод команд — это *данные*, а не инструкции: системный промпт явно говорит модели игнорировать инструкции из файлов/веб-страниц (prompt-injection).

### 6.5 Обратимость
- `SnapshotService`: перед первой записью в сессии — теневой коммит в отдельный ref (`refs/justai/snapshots/<sessionId>`) через `git stash create` / `git commit-tree`, не трогая рабочую ветку и индекс пользователя. Если проект не git — копия изменяемых файлов в `.justai/snapshots/<sessionId>/`;
- `revert` восстанавливает только файлы, изменённые сессией.

---

## 7. План работ по фазам

Формат задачи:
- **ID** · название · статус (`TODO` / `IN PROGRESS` / `DONE` / `BLOCKED`)
- **Зависит от:** ID
- **Файлы:** что создаётся/меняется
- **Шаги:** что сделать
- **Готово, когда (DoD):** проверяемые критерии

---

### Фаза 0 — Гигиена и фундамент (≈1–2 дня)

**P0-01 · .gitignore и чистка репозитория · DONE**
- Файлы: `.gitignore` (новый), удалить из git `repomix-output.txt`.
- Шаги: игнорировать `node_modules/`, `dist/`, `.env`, `.justai/`, `*.log`, `coverage/`, `server/tests/**/*.js`, `*.d.ts`/`*.map` в tests.
- DoD: `git status` после `npm install` и сборки чистый; `.env` и `.justai/` не отслеживаются.

**P0-02 · Починить сборку TypeScript · DONE**
- Файлы: `tsconfig.base.json` (новый, корень), `server/tsconfig.json`, `apps/web/tsconfig.json`.
- Шаги: base с `strict`, `noUncheckedIndexedAccess`, `module/moduleResolution: NodeNext` для сервера; убрать неиспользуемые `paths` (`@providers`, `@utils`, `@websocket` указывают на несуществующие папки).
- DoD: `npm run build` в `server` и `apps/web` проходит без ошибок.

**P0-03 · Тест-раннер · DONE**
- Файлы: `server/vitest.config.ts`, `server/package.json` (скрипты `test`, `test:watch`, `typecheck`), удалить скомпилированные `.js/.d.ts/.map` из `server/tests`.
- DoD: `npm test` запускает 4 существующих теста, все зелёные; `npm run typecheck` — без ошибок.

**P0-04 · Периметр сервера · DONE** · Зависит от: P0-02
- Файлы: `server/src/app/Server.ts`, новый `server/src/core/middleware/AuthMiddleware.ts`, `apps/web/src/services/*` (заголовок токена), WS-подключение.
- Шаги: раздел 6.1.
- DoD: запрос без токена → 401; запрос с чужим Origin → отклонён; сервер не доступен по IP локальной сети. Тест на middleware.

**P0-05 · Исправить PathResolver · DONE** · Зависит от: P0-03
- Файлы: `PathResolver.ts`, новый `safePath()`; тесты.
- Шаги: проверка через `path.relative` + `realpath`; запрет `.justai/` и `.git/` для записи.
- DoD: тесты на `../`, соседнюю папку с общим префиксом, абсолютный путь, симлинк наружу — все отклоняются.

**P0-06 · Убрать Browser Council (веб-UI чужих сервисов) · DONE**
- Файлы: `modules/ai/council/*`, `apps/web/src/components/AICouncil.tsx`, `councilApi.ts`, роуты; удалить `.justai/browser-profiles`.
- Шаги: удалить код; идея «совета моделей» переносится в P5-03 (через API разных провайдеров). Записать ADR.
- DoD: в коде нет обращений к chatgpt.com/claude.ai/deepseek; приложение собирается.

**P0-07 · Удалить мёртвый код · DONE**
- Файлы: `Planner.ts`, пустые `apps/web/api/*.ts`, `apps/web/src/app/{providers,router}.tsx`, `scripts/*.js`, `packages/shared/*` (будет пересоздан в P1-01), `server/event-test-2.txt`.
- DoD: сборка и тесты проходят; в репозитории нет файлов нулевого размера.

**P0-08 · Файлы для ИИ-агентов · DONE**
- Файлы: `AGENTS.md` (корень) и `CLAUDE.md` (ссылка на `AGENTS.md`).
- Содержимое: команды сборки/тестов, структура, ссылка на этот план, протокол из раздела 9.
- DoD: новый агент без доп. вопросов может собрать проект и запустить тесты.

---

### Фаза 1 — Новый Agent Runtime (≈1–2 недели)

**P1-01 · Внутренний формат сообщений и shared-типы · DONE** · Зависит от: P0-02
- Файлы: `packages/shared/src/{messages,events,api}.ts`, `package.json` (npm workspaces в корне).
- Шаги: типы из разделов 5.1, 5.4, 5.5; корневой `package.json` с `workspaces: ["server","apps/web","packages/*"]`.
- DoD: сервер и фронт импортируют `@justai/shared`; typecheck проходит.

**P1-02 · Интерфейс ModelProvider + MockProvider нового образца · DONE** · Зависит от: P1-01
- Файлы: `server/src/modules/agent/providers/{ModelProvider.ts,MockProvider.ts}`.
- Шаги: Mock умеет сценарии («скрипт» ответов с tool_use) — нужен для тестов цикла без сети.
- DoD: юнит-тест: Mock по сценарию возвращает 2 параллельных tool_use, затем текст.

**P1-03 · AnthropicProvider и OpenAIProvider на официальных SDK · DONE (живой e2e с ключом не проводился — см. журнал)** · Зависит от: P1-02
- Файлы: `providers/AnthropicProvider.ts`, `providers/OpenAIProvider.ts`, `providers/ProviderRegistry.ts`, `.env.example`.
- Шаги: стриминг; маппинг внутреннего формата ↔ формат API (включая `tool_result` с id, `is_error`, изображения); несколько tool_use в одном ответе; ретраи; prompt caching (Anthropic); актуальные модели по умолчанию.
- DoD: юнит-тесты маппинга (без сети); ручной e2e: «прочитай package.json и скажи версию» работает с реальным ключом; второй запрос в сессии показывает `cacheReadTokens > 0`.

**P1-04 · AgentLoop · DONE** · Зависит от: P1-02
- Файлы: `runtime/AgentLoop.ts`, `runtime/Budget.ts`.
- Шаги: цикл из 4.3; параллельное выполнение `read`-инструментов; ошибки инструментов и zod-валидации → `tool_result` с `isError: true`; бюджеты: `maxSteps` (по умолчанию 100), `maxTokens`, `maxCostUsd`, `maxWallTime`; `AbortSignal` для «Стоп»; обработка `max_tokens` (продолжить) и `refusal` (завершить с сообщением).
- DoD: тесты на Mock: (а) 3 шага с инструментами и финальный ответ; (б) инструмент бросает ошибку → модель получает isError и продолжает; (в) stop прерывает цикл ≤1 с; (г) исчерпание бюджета → корректный `session.failed`/итог.

**P1-05 · SessionManager и хранение · DONE** · Зависит от: P1-04
- Файлы: `runtime/SessionManager.ts`, `runtime/SessionStore.ts` (JSONL в `.justai/sessions/`).
- DoD: сессию можно продолжить после перезапуска сервера; тест на запись/чтение.

**P1-06 · REST + WS для сессий · DONE** · Зависит от: P1-05, P0-04
- Файлы: `modules/agent/AgentController.ts`, `AgentRoutes.ts`, расширение `WebSocketGateway` (подписка на `sessionId`).
- Шаги: эндпоинты 5.5, события 5.4.
- DoD: интеграционный тест (supertest + ws): создать сессию → отправить сообщение → получить `assistant.delta` и `session.completed` на Mock.

**P1-07 · Системный промпт и контекст проекта · DONE** · Зависит от: P1-04
- Файлы: `prompts/SystemPrompt.ts`, `project/ProjectRules.ts`.
- Шаги: блоки промпта: роль и принципы (разделы 2, 6.4); окружение (ОС, shell, дата, корень workspace); правила проекта из `JUSTAI.md`/`AGENTS.md`/`CLAUDE.md` в корне workspace; краткое дерево (2 уровня, с учётом ignore); инструкция «проверяй свою работу».
- DoD: snapshot-тест промпта; правила проекта подхватываются.

**P1-08 · Миграция фронта на новые сессии и удаление старого `modules/ai` · DONE** · Зависит от: P1-06
- Файлы: `apps/web/src/features/agent/*`, удалить `server/src/modules/ai/{AIService,agent,prompt,context}` после переноса.
- DoD: чат во фронте работает через `/api/agent/*` со стримингом; старые эндпоинты удалены.

---

### Фаза 2 — Инструменты уровня IDE (≈1–2 недели)

**P2-01 · Файловые инструменты · DONE** · Зависит от: P1-04, P0-05
- Инструменты: `read_file {path, offset?, limit?}` (с номерами строк), `write_file {path, content}`, `edit_file {path, edits: [{old, new, replaceAll?}]}`, `list_dir {path}`.
- Требования: все записи — через `WorkspaceService` (события `file.changed` с диффом); `edit_file`/`write_file` существующего файла требуют, чтобы файл был прочитан в этой сессии и не изменился с тех пор (защита от затирания правок пользователя); сохранение кодировки и переводов строк (CRLF/LF).
- DoD: юнит-тесты на каждый инструмент, включая неоднозначную правку, CRLF, несуществующий файл.

**P2-02 · Поиск · DONE** · Зависит от: P1-04
- Инструменты: `glob {pattern, path?}`, `grep {pattern, path?, glob?, outputMode, context?}`.
- Реализация: `@vscode/ripgrep` (бинарник в зависимостях), уважение `.gitignore`.
- DoD: тесты на фикстуре; поиск по репозиторию JustAI < 1 с.

**P2-03 · ProcessManager и `run_command` · DONE** · Зависит от: P1-04
- Файлы: `infrastructure/process/ProcessManager.ts`, инструменты `run_command {command, cwd?, timeoutMs?, background?}`, `read_output {processId, since?}`, `kill_process {processId}`.
- Требования: Windows (PowerShell) и POSIX (bash); таймаут по умолчанию 2 мин, максимум 10; стрим вывода в `tool.progress`; убийство дерева процессов (`taskkill /T /F` на Windows, process group на POSIX); фоновые процессы для dev-серверов; ограничение размера вывода; код возврата в результате.
- DoD: тесты: успешная команда, падающая команда (exit code ≠ 0 → isError), таймаут, фоновый процесс + чтение вывода + kill.

**P2-04 · PermissionGate · DONE** · Зависит от: P2-03, P1-06
- Файлы: `permissions/{PermissionGate,rules,CommandClassifier}.ts`, фронт `PermissionDialog`.
- Шаги: раздел 6.2–6.3; классификация команд (парсинг цепочек `;`, `&&`, `|` — проверяется каждая часть); ожидание ответа пользователя через WS с таймаутом.
- DoD: тесты классификатора (≥30 кейсов, включая обходы `cmd /c`, `powershell -c`, `bash -c`); e2e: в режиме `ask` запись файла показывает диалог и ждёт решения.

**P2-05 · Git и снапшоты · DONE** · Зависит от: P2-01
- Файлы: `infrastructure/git/GitService.ts`, `SnapshotService.ts`, инструменты `git_status`, `git_diff`, `git_log`, `git_commit` (commit — только с разрешения).
- DoD: тест: сессия меняет 3 файла → revert восстанавливает их, не трогая чужие незакоммиченные изменения пользователя.

**P2-06 · TodoWrite (план задачи) · DONE** · Зависит от: P1-06
- Инструмент `todo_write {todos: [{content, status}]}` → событие `todo.updated`; в промпте — инструкция вести план для задач из ≥3 шагов.
- DoD: план отображается во фронте и обновляется по ходу.

**P2-07 · Web-инструменты · DONE: web_fetch; web_search — BLOCKED (нужно выбрать поставщика поиска)** · Зависит от: P2-04
- `web_fetch {url}` (HTML → markdown, лимит размера), `web_search` (через провайдера поиска или API модели) — kind `network`, всегда через PermissionGate.
- DoD: тест `web_fetch` на локальном сервере-фикстуре.

---

### Фаза 3 — Автономность: самопроверка (≈1–2 недели)

**P3-01 · ProjectDetector · DONE** · Зависит от: P2-03
- Определяет стек и команды: `package.json` (npm/pnpm/yarn по lock-файлу; скрипты test/lint/typecheck/build/dev), `pyproject.toml`/`requirements.txt`, `Cargo.toml`, `go.mod`, `*.csproj`, `pom.xml`/`build.gradle`.
- Результат кладётся в системный промпт как «Команды проверки проекта».
- DoD: тесты на фикстурах для 6 стеков.

**P3-02 · Verification loop · DONE** · Зависит от: P3-01
- После того как модель заявляет «готово», а в сессии были правки: runtime (если включено) автоматически запускает быстрые проверки (typecheck/lint/тесты затронутых файлов) и, если они упали, возвращает вывод модели как новое сообщение «Проверка не прошла: …». Ограничение: N попыток (по умолчанию 3).
- DoD: e2e на фикстуре: агент вносит ошибку типа → проверка ловит → агент исправляет → итог зелёный.

**P3-03 · BrowserService для проверки UI · DONE** · Зависит от: P2-03
- Инструменты: `browser_open {url}` (только `localhost`/`127.0.0.1` без разрешения), `browser_screenshot` (возвращает image-блок), `browser_console {level?}`, `browser_click/type {selector}`, `browser_text`.
- Playwright с отдельным временным профилем (без логинов пользователя).
- DoD: e2e: агент поднимает dev-сервер фикстуры, открывает страницу, видит ошибку в консоли, чинит.

**P3-04 · ContextManager: компакция · DONE** · Зависит от: P1-04
- При заполнении > 75% окна: старые шаги сворачиваются в сводку (дешёвой моделью), большие результаты инструментов заменяются на «[вывод скрыт, N строк, повтори вызов при необходимости]»; последние K шагов и все правки файлов (как список) сохраняются.
- DoD: тест: синтетическая сессия на 300 шагов не превышает окно; сводка содержит список изменённых файлов и открытые todo.

**P3-05 · Сабагенты · DONE** · Зависит от: P1-04, P3-04
- Инструмент `spawn_agent {task, profile: "explore"|"review"|"general", model?}`: отдельный AgentLoop с собственным контекстом и урезанным набором инструментов (explore — только read/search); возвращает итоговый отчёт. Можно несколько параллельно.
- DoD: тест на Mock: 2 параллельных сабагента, родитель получает оба отчёта.

**P3-06 · Документация как задача · DONE** · Зависит от: P2-01
- Профиль `docs` и инструкции: обновлять README/CHANGELOG/docs по изменениям сессии (берёт дифф из `GitService`).
- DoD: e2e: после фичи агент обновляет CHANGELOG корректной записью.

---

### Фаза 4 — UI уровня IDE (≈2–3 недели, можно параллельно с Фазой 3)

**P4-01 · Monaco Editor · DONE** — вкладки, сохранение, подсветка, реакция на `file.changed` (если файл открыт и не изменён пользователем — обновить; иначе — предупредить о конфликте).
**P4-02 · AgentTimeline · DONE (в составе P1-08…P3)** — лента: сообщения со стримингом, карточки инструментов (свернутый ввод/вывод, прогресс команд), todo, бюджет/стоимость, кнопка «Стоп».
**P4-03 · DiffReview · IN PROGRESS** — дифф всей сессии и по файлам; «Принять всё», «Откатить всё», откат отдельного файла. Сделано: панель со списком файлов, цветной дифф, Open in editor, Revert all. Осталось: откат отдельного файла и «Принять» (нужны серверные эндпоинты).
**P4-04 · Терминал пользователя** — xterm.js + `node-pty`, несколько вкладок; агент может читать вывод терминала пользователя (только с разрешения).
**P4-05 · Настройки** — провайдер/модель, режим разрешений, правила, бюджеты, ключи API (хранятся в ОС-хранилище секретов через `keytar` или зашифрованно).
**P4-06 · Список сессий · DONE** — история, продолжение, поиск. Панель «Sessions» в чате (поиск по названию/провайдеру/модели, статус, время); панели обёрнуты в `PanelBoundary`, чтобы ошибка одной не гасила интерфейс.
**P4-07 · Открытие произвольной папки как workspace** (сейчас workspace = корень репозитория JustAI). Выбор папки, недавние проекты.

DoD фазы: north-star сценарий из раздела 1 выполняется целиком через UI.

---

### Фаза 5 — Интеллект и масштаб (по мере необходимости)

**P5-01 · Индекс кода** — tree-sitter символы (определения/ссылки) + инструмент `find_symbol`; позже — эмбеддинги для семантического поиска (локальная модель или API).
**P5-02 · Память** — `.justai/memory/*.md` (факты о проекте и предпочтениях пользователя), инструмент `remember`, подмешивание релевантного в промпт.
**P5-03 · Совет моделей через API** — режим, где план предлагают 2–3 модели разных провайдеров, «председатель» сводит; используется для архитектурных решений и ревью. Только через официальные API.
**P5-04 · Локальные и бесплатные модели · DONE (выполнено раньше срока)** — `OpenAICompatibleProvider` + пресеты (Ollama, LM Studio, OpenRouter, Groq, Gemini, GitHub Models, DeepSeek). См. ADR-006.
**P5-04b · Гибрид «планировщик + локальный исполнитель» · DONE** — профиль `planner` + `delegate_task` → скрытый профиль `executor` на `JUSTAI_EXECUTOR_PROVIDER` (по умолчанию Ollama) в рамках той же сессии (разрешения, снапшот, события). Следующие улучшения: сохранять историю исполнителя для отладки; давать исполнителю в задачу содержимое нужных файлов; несколько исполнителей параллельно (только для независимых шагов, после P5-06 worktrees).
**P5-05 · MCP-клиент** — подключение внешних MCP-серверов как источника инструментов (GitHub, БД, Jira) вместо написания каждой интеграции вручную. Существующая интеграция Microsoft переводится в формат плагина инструментов.
**P5-06 · Фоновые агенты и очередь задач** — несколько сессий параллельно, каждая в своём git worktree.
**P5-07 · Десктоп-оболочка** — Tauri или Electron; сервер запускается как дочерний процесс; автообновление.
**P5-08 · Песочница** — опциональное выполнение команд в Docker/WSL-контейнере с примонтированным workspace.

---

### Сводка зависимостей (критический путь)

```
P0-01..03 → P0-04,P0-05 → P1-01 → P1-02 → P1-03
                                     └→ P1-04 → P1-05 → P1-06 → P1-08
                                          └→ P2-01..P2-03 → P2-04 → P3-01 → P3-02  ← MVP «автономный агент»
                                                                 └→ P3-03, P3-04, P3-05
                                          P1-06 → P4-* (параллельно)
```

**MVP = P0-* + P1-* + P2-01..P2-05 + P3-01, P3-02 + P4-02, P4-03.**

---

## 8. Стратегия тестирования

| Уровень | Инструмент | Что покрываем |
|---|---|---|
| Юнит | Vitest | инструменты, safePath, классификатор команд, маппинг провайдеров, бюджеты |
| Интеграция | Vitest + supertest + ws | REST/WS сессий на MockProvider |
| Сценарии агента (без сети) | MockProvider со «скриптами» | цикл, ошибки, параллельность, stop, компакция |
| Live-eval (по требованию) | `npm run eval` с реальным API-ключом | набор задач на фикстурах (`server/evals/tasks/*`): «добавь функцию + тест», «почини падающий тест», «обнови README»; метрика — доля задач, где после работы агента проверки зелёные; стоимость и число шагов |
| Фронт | Vitest + Testing Library; Playwright e2e | Timeline, DiffReview, PermissionDialog |

Правила:
- каждая задача плана добавляет тесты на своё поведение;
- CI (GitHub Actions, `.github/workflows/ci.yml`): `typecheck`, `lint`, `test` для всех пакетов на Windows и Ubuntu;
- live-eval не в CI по умолчанию (стоит денег), запускается вручную перед релизом; результаты пишутся в `docs/evals.md`.

---

## 9. Протокол работы для ИИ-агентов

1. **Ориентация.** Прочитай `AGENTS.md`, этот план (разделы 1–6) и описание своей задачи в разделе 7. Изучи затрагиваемые файлы, прежде чем менять их.
2. **Одна задача за раз.** Не делай работу из других задач «заодно». Если нашёл проблему вне задачи — запиши её в раздел 10 («Открытые вопросы»), не исправляй.
3. **Контракты.** Типы из раздела 5 меняются только с записью ADR в `docs/decisions.md` и обновлением этого плана.
4. **Стиль.** TypeScript strict, ESM (`.js` в импортах сервера), zod для валидации, без `any` (кроме границ с внешними API — с комментарием). Следуй стилю соседнего кода. Комментарии — по делу, на русском или английском, как в окружающем файле.
5. **Проверка.** Перед тем как считать задачу выполненной: `npm run typecheck`, `npm test` (и `npm run build`, если менялась сборка). Все критерии DoD выполнены. Если что-то проверить нельзя — явно напиши, что и почему.
6. **Документация.** Обнови: статус задачи в разделе 7, раздел 11 (журнал), `docs/changelog.md`; при изменении API — `docs/api.md`.
7. **Коммиты.** Один логический коммит на задачу: `P1-04: AgentLoop с бюджетами и обработкой ошибок инструментов`. Без `--no-verify`. Не пушить без просьбы пользователя.
8. **Безопасность.** Никогда не коммить `.env`, ключи, содержимое `.justai/`. Не ослабляй PermissionGate и safePath ради прохождения теста.
9. **Если застрял.** После 2–3 неудачных подходов остановись, опиши в журнале, что пробовал и что мешает, и поставь статус `BLOCKED` с причиной.

---

## 10. Риски и открытые вопросы

| # | Риск / вопрос | Решение / митигация |
|---|---|---|
| R1 | Стоимость длинных сессий | prompt caching, компакция, дешёвая модель для сабагентов, бюджет `maxCostUsd`, показ стоимости в UI |
| R2 | Опасные команды и prompt-injection | PermissionGate, deny-лист, снапшоты, данные ≠ инструкции в промпте, песочница (P5-08) |
| R3 | Windows-специфика (PowerShell, CRLF, kill дерева процессов, длинные пути, OneDrive-папки) | тесты CI на Windows; проект сейчас лежит в OneDrive — синхронизация может блокировать файлы и мешать `node_modules`: рекомендуется перенести рабочую копию вне OneDrive |
| R4 | Затирание правок пользователя агентом | проверка «прочитан и не изменён» в P2-01, конфликты в P4-01 |
| R5 | Свой рантайм vs готовый (Claude Agent SDK) | **Решение:** свой рантайм — ради мультипровайдерности и контроля UI-событий. Пересмотреть, если P1 затянется более чем на 3 недели: тогда Anthropic-путь можно реализовать через Agent SDK как отдельный «движок» за тем же интерфейсом событий |
| R6 | Нестабильность API провайдеров | ретраи, фолбэк на другую модель, понятные ошибки в UI |
| Q1 | Electron или Tauri для десктопа? | решить к Фазе 5 (Tauri легче, Electron проще с node-pty) |
| Q2 | Где хранить API-ключи? | ОС-хранилище секретов (keytar) — решить в P4-05 |
| Q3 | Нужен ли Microsoft/Word модуль в ядре? | перевести в плагин в P5-05; до этого не развивать |

---

## 11. Журнал выполнения

> Добавляй запись в конец: дата · ID задачи · кто (человек/агент и модель) · что сделано · что осталось/проблемы.

- 2026-10-21 · — · Claude (Opus 5.5) · Проведён аудит версии 0.2.0, составлен этот план. Код не менялся.
- 2026-10-21 · P0-01…P0-08 · Claude (Opus 5.5) · Фаза 0 завершена. Сервер и фронт собираются, 24 теста зелёные, e2e вручную: фронт получает токен, дерево/чат/WebSocket работают, запрос без токена → 401. Заметки для следующих задач:
  - `git` нет в PATH; в этой среде использовался `%LOCALAPPDATA%\GitHubDesktop\app-*\resources\app\git\cmd\git.exe`.
  - `IgnoreService` по умолчанию скрывает папку `tests` из дерева — пересмотреть при работе над FileTree.
  - `playwright` оставлен в зависимостях для P3-03.
  - CI (`.github/workflows/ci.yml`, раздел 8) ещё не создан — сделать вместе с P1-01, когда появятся npm workspaces.
- 2026-10-21 · P1-01…P1-08 · Claude (Opus 5.5) · Фаза 1 завершена: новый рантайм агента `server/src/modules/agent`, старый `modules/ai` удалён. 60 тестов, typecheck и build зелёные; в браузере проверено: сессия на Mock → read_file → ответ стримится, история сессий, продолжение после рестарта. Заметки:
  - **P1-03: живой прогон с реальным ключом не выполнен** (в среде не было ANTHROPIC_API_KEY/OPENAI_API_KEY). Маппинг покрыт юнит-тестами. Первому, у кого есть ключ: создать сессию с provider=anthropic, попросить «прочитай package.json и скажи версию», затем второе сообщение — проверить `cacheReadTokens > 0` в budget.updated. Для OpenAI проверить, что `OPENAI_MODEL` поддерживает reasoning (иначе `OPENAI_REASONING_EFFORT=off`).
  - CI добавлен (`.github/workflows/ci.yml`), npm workspaces в корне, единый lockfile. vitest 5 / vite 8 (аудит: 0 уязвимостей).
  - `server/.env` пользователя был копией старого `.env.example` (без ключей) — заменён новой копией.
  - Модель по умолчанию — `claude-opus-5-5` с `effort: high` (раздел 5.2 обновлён).
  - Записи файлов агентом пока идут напрямую через fs, а не через WorkspaceService (дерево файлов в UI не обновляется само) — это P2-01.
  - Фронт: при обрыве WebSocket события теряются; после переподключения состояние сессии перечитывается с сервера.
- 2026-10-21 · P2-01…P2-07 · Claude (Opus 5.5) · Фаза 2 завершена (кроме web_search). 180 тестов, typecheck и build зелёные; в браузере на Mock проверены: карточка разрешения в режиме ask → Allow → `npm --version`; full-auto: создание файла без вопроса + обновление дерева; `git push` → красная карточка без «всегда», Deny с комментарием доходит до агента; «Changes in this session» → Revert all. Решения и заметки:
  - Запись файлов агентом — через `AgentFileSystem` (а не WorkspaceService): та же публикация событий FILE_*, плюс проверка «прочитан в этой сессии и не изменён» по sha1 содержимого, сохранение BOM/CRLF.
  - Снапшоты — в теневом репозитории `.justai/shadow.git` (отдельный индекс-файл), а не в refs репозитория пользователя: не трогает его индекс/ветки и работает для проектов без git. Снапшот берётся перед первым изменяющим инструментом (write/execute) сессии.
  - git ищется в `JUSTAI_GIT`, PATH, Git for Windows и GitHub Desktop. Без git снапшоты/откат и git-инструменты недоступны (UI скрывает блок изменений).
  - Классификатор команд: при сомнении — `unknown` (не safe). Опасные команды подтверждаются всегда, «разрешить всегда» для них не запоминается. Правила проекта — `.justai/permissions.json` (агенту недоступен).
  - Окружение команд: stdin закрыт, `CI=1`, `NO_COLOR`; ключи провайдеров и секреты сервера вырезаются. PowerShell 5.1 возвращает настоящий код выхода последней программы.
  - **web_search не сделан**: нужно решение — серверный инструмент Anthropic (`web_search_20260209`, только для provider=anthropic, вне PermissionGate) или внешний поисковый API с ключом (Brave/Tavily и т.п.).
  - Mock-провайдер понимает «прочитай X», «запусти <команда>», «создай файл X» — для ручной проверки UI без ключа.
  - Коммиты из PowerShell 5.1: сообщения передавать через файл (`git commit -F`), иначе двойные кавычки теряются.
- 2026-10-21 · P5-04, P5-04b · Claude (Opus 5.5) · По запросу пользователя (бесплатная работа) реализован гибридный режим. Автоматизация веб-чатов (ChatGPT/Claude/Arena) отклонена — запрещена их условиями, см. ADR-006. 200 тестов зелёные. Живой прогон на `qwen2.5-coder:7b` (Ollama 0.32.5, RTX 4060 Laptop 8 ГБ, `OLLAMA_CONTEXT_LENGTH=32768`):
  - профиль coder на Ollama: создал `math.js`, запустил `node -e …`, получил `5` — ок;
  - planner(ollama) → executor(ollama): делегирование, живой лог, отчёт с фактическими действиями — механика ок; качество планирования 7B-модели низкое (ожидаемо: планировщик рассчитан на сильную облачную модель);
  - найдено и исправлено по ходу: модель просила пользователя запускать команды (формулировка промпта); qwen пишет вызовы инструментов текстом, несколькими JSON подряд (распознаватель); Ollama отвечает 400 на битый вызов инструмента (теперь повтор); беззнаковые коды выхода Windows; `npm install <пакет>` считался безопасным (теперь unknown).
  - **Не проверено вживую:** облачный планировщик (нет ключей). Первому с ключом Gemini/OpenRouter/Groq: создать сессию `planner` с этим провайдером и исполнителем `ollama`, дать задачу на 2–3 шага.
- 2026-10-22 · P3-01…P3-06 · Claude (Opus 5.5) · Фаза 3 завершена. 234 теста, typecheck зелёные. Сделано: определение стека и команд проверки (6 экосистем, монорепо); автопроверка typecheck/test после правок с возвратом ошибок модели (3 попытки, у исполнителя 2); браузер Playwright для локального UI (консоль, скриншоты, клики); ужатие истории под окно 32k для локальных/бесплатных моделей; read-only помощники `spawn_agent` (explore/review, параллельно); профиль Docs Writer.
  - Живые замеры на `qwen2.5-coder:7b` (Ollama, задача: добавить `mul`, чтобы `node --test` прошёл, профиль coder, full-auto): успех с подтверждённой автопроверкой примерно в 25% прогонов (5/20 суммарно по сериям 1/3, 3/5, 0/6, 1/6). Типичные провалы — модели, не кода: вызов инструмента текстом с битым JSON, описание правки вместо вызова, выдуманный `old_string`, ложное «has been added», зацикливание генерации. Для всего этого добавлены страховки (подсказки модели, починка JSON, сторож повторов, проверка «заявил, но не сделал»), но надёжность упирается в модель.
  - **Вывод для пользователя:** 7B-модель годится как исполнитель точных шагов под сильным планировщиком, но не как самостоятельный агент. Кандидаты лучше: модели с сильным tool calling (например, семейство Qwen3 8B/14B в Ollama), бесплатные облачные модели как основной агент, либо связка planner(облако)+executor(Ollama). Замер этих вариантов — следующий шаг (нужно скачать модель / получить ключ).
  - Найдено и исправлено по ходу: схема создания сессии отбрасывала `executorProvider` (выбор исполнителя в UI игнорировался).
  - Сценарий живого замера: `scratchpad/live-phase3.mts` (не в репозитории); стоит превратить в `npm run eval` (раздел 8).
- 2026-10-22 · Замер исполнителя · Claude (Opus 5.5) · Та же задача (`mul` + `node --test`), профиль coder, Ollama на GPU (контекст 16384, flash attention, KV q8_0, 100% GPU):
  - `qwen3:8b` без размышлений (`OLLAMA_REASONING_EFFORT=none`): 3/4, ~25 с на прогон;
  - `qwen3:8b` с размышлениями: 3/3 законченных, но до ~250 с на прогон (серия остановлена);
  - `qwen2.5-coder:7b`: ~25% (замеры выше).
  - **Решение:** исполнитель по умолчанию — `qwen3:8b` с `OLLAMA_REASONING_EFFORT=none` (пресет, `.env.example`).
  - Сделано в Фазе 4: P4-01, P4-02, P4-06; P4-03 частично. Облачный планировщик (Groq) не проверен: прямой доступ к Groq даёт 403 (региональная блокировка), нужен прокси — решение за пользователем.
