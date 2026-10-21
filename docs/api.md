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
| POST | `/api/agent/sessions` | `201 { session }`; body `{ profile?, provider?, model? }` |
| GET | `/api/agent/sessions` | `{ sessions }` (новые сверху) |
| GET | `/api/agent/sessions/:id` | `{ session, messages }` |
| POST | `/api/agent/sessions/:id/messages` | `202 { session }`; body `{ text, activeFile? }`; `409`, если агент уже работает |
| POST | `/api/agent/sessions/:id/stop` | `{ session }` после остановки цикла |

Ход работы агента приходит по WebSocket (`ws://localhost:4302/?token=<token>`) событиями
`AgentEvent` из `packages/shared/src/events.ts`: `session.status`, `assistant.delta`,
`assistant.thinking_delta`, `message.added`, `tool.started`, `tool.finished`, `budget.updated`.
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