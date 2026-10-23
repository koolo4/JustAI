# REST API

Все запросы к `/api/*` (кроме `/api/health` и `/api/auth/token`) требуют заголовок
`Authorization: Bearer <token>`. Токен создаётся при старте сервера и лежит в `.justai/runtime.json`;
фронт получает его через `GET /api/auth/token` (только для разрешённого Origin).
Ошибки: `{ "success": false, "error": { "code": "...", "message": "..." } }`.

## Agent

Типы запросов и ответов — `packages/shared/src/api.ts`.

| Метод | Путь | Ответ |
|---|---|---|
| GET | `/api/agent/providers` | `{ providers: [{ id, label, configured, model }], defaultProvider }` |
| GET | `/api/agent/profiles` | `{ profiles: [{ id, label, description, tools }] }` |
| POST | `/api/agent/sessions` | `201 { session }`; body `{ profile?, provider?, model?, mode? }` |
| GET | `/api/agent/sessions` | `{ sessions }` (новые сверху) |
| GET | `/api/agent/sessions/:id` | `{ session, messages, pendingPermissions, todos }` |
| PATCH | `/api/agent/sessions/:id` | `{ session }`; body `{ mode: "ask" \| "auto-edit" \| "full-auto" }` |
| POST | `/api/agent/sessions/:id/messages` | `202 { session }`; body `{ text, activeFile? }`; `409`, если агент уже работает |
| POST | `/api/agent/sessions/:id/stop` | `{ session }` после остановки цикла |
| POST | `/api/agent/sessions/:id/permissions/:requestId` | `204`; body `{ decision: "allow" \| "allow_always" \| "deny", note? }`; `404`, если запрос уже не ждёт ответа |
| GET | `/api/agent/sessions/:id/changes` | `{ available, files: [{ path, status }], diff }` — изменения с первой правки агента |
| POST | `/api/agent/sessions/:id/revert` | Тело `{ paths? }` (без него — все файлы). `{ files }` — откат к снапшоту; `409`, если агент работает или нет git |
| GET | `/api/settings` | `{ fields }` — настраиваемые переменные; ключи только маской `••••abcd` |
| PUT | `/api/settings` | Тело `{ values: { NAME: "value" \| null } }` (`null` — вернуть значение из `server/.env`). `202`, затем сервер пересобирается с новыми настройками; `400` — неизвестная переменная или неверное значение; `409` — агент работает |
| POST | `/api/completion` | Тело `{ path, prefix, suffix }` → `{ completion, model }` — подсказка локальной модели; при ошибке — пустая строка |
| GET | `/api/terminals` | `{ terminals: [{ id, title, alive, buffer }] }` — открытые терминалы с хвостом вывода |
| POST | `/api/terminals` | Тело `{ cols, rows }` → `201 { id, title, alive }`; вывод — события `terminal.output { terminalId, data }` и `terminal.exit` по WebSocket |
| POST | `/api/terminals/:id/input` | Тело `{ data }` — ввод с клавиатуры; `204` |
| POST | `/api/terminals/:id/resize` | Тело `{ cols, rows }`; `204` |
| DELETE | `/api/terminals/:id` | Закрыть терминал; `204` |
| GET | `/api/agent/mcp` | `{ configFiles, servers: [{ name, status, tools, error? }] }` — подключённые MCP-серверы |
| GET | `/api/workspace/diagnostics` | `{ checks, diagnostics, unparsed }` — запуск typecheck/lint проекта и разобранные ошибки `{ path, line, column, severity, code?, message }` |
| GET | `/api/workspace/info` | `{ root, name, recent, switchable }` — текущая папка проекта и недавние |
| POST | `/api/workspace/open` | Тело `{ path }` (абсолютный путь к папке). `202` и новая информация, затем сервер перезапускается на этой папке (токен прежний); `400` — папка не найдена/недопустима; `409` — агент работает |
| POST | `/api/agent/sessions/:id/accept` | `204` — принять изменения: снапшот забывается, откат больше невозможен; `409`, если агент работает или нет git |

Ход работы агента приходит по WebSocket (`ws://localhost:4302/?token=<token>`) событиями
`AgentEvent` из `packages/shared/src/events.ts`: `session.status`, `assistant.delta`,
`assistant.thinking_delta`, `message.added`, `tool.started`, `tool.progress`, `tool.finished`,
`budget.updated`, `file.changed`, `todo.updated`, `permission.request`, `permission.resolved`.

Режимы разрешений: `ask` — подтверждать изменения файлов, команды и сеть; `auto-edit` — правки и безопасные
команды без вопросов; `full-auto` — всё, кроме опасных команд и сети. Правила проекта —
`.justai/permissions.json`: `{ "allow": ["npm run e2e"], "deny": ["npm publish"] }`.
По тому же сокету идут события файлов (`FILE_CREATED`, `FILE_SAVED`, …).

Пример (PowerShell, токен из `.justai/runtime.json`):

```bash
curl -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "{\"provider\":\"mock\"}" http://localhost:4302/api/agent/sessions
```

## Health

GET /api/health

Response

```json
{
    "status":"ok",
    "version":"0.1.0"
}
```

---

## Workspace

### GET /api/workspace/tree

Получить дерево проекта.

---

### GET /api/workspace/file

Query

path=src/index.ts

---

### PUT /api/workspace/file

```json
{
    "path":"src/index.ts",
    "content":"..."
}
```

---

### POST /api/workspace/file

```json
{
    "path":"src/test.ts"
}
```

---

### POST /api/workspace/folder

```json
{
    "path":"src/components"
}
```

---

### DELETE /api/workspace

```json
{
    "path":"src/test.ts"
}
```

---

### POST /api/workspace/rename

```json
{
    "oldPath":"src/test.ts",
    "newPath":"src/test2.ts"
}
```

---

### POST /api/workspace/move

```json
{
    "source":"src/test.ts",
    "destination":"components/test.ts"
}
```