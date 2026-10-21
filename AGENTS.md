# AGENTS.md — инструкции для ИИ-агентов

Главный документ проекта: **[docs/MASTER_PLAN.md](docs/MASTER_PLAN.md)**.
Перед любой работой прочитай в нём разделы 1–6 и 9, затем возьми первую задачу `TODO` из раздела 7, у которой выполнены зависимости.

## Структура
- `server/` — backend (Node 22+, TypeScript strict, Express, ESM: в импортах указывай `.js`)
- `apps/web/` — frontend (React + Vite)
- `packages/shared/` — общие типы (создаётся в задаче P1-01)
- `docs/` — документация, ADR (`docs/decisions.md`), changelog
- `.justai/` — локальное состояние сервера (токен, сессии). В git не попадает, агентским инструментам недоступно.

## Команды
```bash
npm --prefix server install
npm --prefix server run dev          # сервер на http://127.0.0.1:4302
npm --prefix server test             # Vitest
npm --prefix server run typecheck    # tsc для src и tests
npm --prefix server run build
npm --prefix apps/web install
npm --prefix apps/web run dev        # фронт на http://localhost:3000
npm --prefix apps/web run typecheck
```

Задача считается выполненной, только когда `typecheck` и `test` проходят (раздел 9 плана).

## Безопасность (не ослаблять)
- Все `/api` запросы требуют `Authorization: Bearer <token>`. Токен генерируется при старте и лежит в `.justai/runtime.json`; фронт получает его через `GET /api/auth/token` (только для разрешённого Origin). См. `server/src/core/security/AccessGuard.ts`.
- Пути для инструментов агента разрешаются только через `resolveSafePath` (`server/src/infrastructure/filesystem/safePath.ts`).
- Не коммить `.env`, ключи и содержимое `.justai/`.

## Правила
- Одна задача плана за раз; по завершении обнови статус задачи и журнал (раздел 11 плана).
- Один логический коммит на задачу: `P1-04: краткое описание`.
- Тесты кладутся в `server/tests/` зеркально `src/`; временные файлы — через `tests/helpers/tempWorkspace.ts`.
- В Windows PowerShell 5.1 не читай/пиши UTF-8 файлы через `Get-Content`/`Set-Content` без `-Encoding utf8` — испортится кириллица.
