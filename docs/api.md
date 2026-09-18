# REST API

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