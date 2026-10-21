# AGENTS.md — инструкции для ИИ-агентов

Главный документ проекта: **[docs/MASTER_PLAN.md](docs/MASTER_PLAN.md)**.
Перед любой работой прочитай в нём разделы 1–6 и 9, затем возьми первую задачу `TODO` из раздела 7, у которой выполнены зависимости.

## Структура
npm workspaces: один `npm install` в корне, один `package-lock.json`.
- `packages/shared/` — контракты сервер ↔ фронт: сообщения, события, API (`@justai/shared`, собирается в `dist/`)
- `server/` — backend (Node 22+, TypeScript strict, Express, ESM: в импортах указывай `.js`)
  - `src/modules/agent/` — рантайм агента: `runtime/` (AgentLoop, сессии, бюджет), `providers/`, `tools/`, `prompts/`
- `apps/web/` — frontend (React + Vite)
- `docs/` — документация, ADR (`docs/decisions.md`), changelog, `api.md`
- `.justai/` — локальное состояние сервера (токен, сессии). В git не попадает, агентским инструментам недоступно.

## Команды (из корня)
```bash
npm install
npm run typecheck                    # shared + server (src и tests) + web
npm test                             # Vitest (server)
npm run build
npm run dev:server                   # сервер на http://127.0.0.1:4302
npm run dev:web                      # фронт на http://localhost:3000
```
Без API-ключа работает провайдер `mock`. Ключи и модели — в `server/.env` (образец `server/.env.example`).
Локальные модели: Ollama запускать с большим контекстом, иначе промпт обрезается молча:
```powershell
$env:OLLAMA_CONTEXT_LENGTH=32768; ollama serve
```
Папку проекта для агента задаёт `JUSTAI_WORKSPACE` (по умолчанию — корень этого репозитория).

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
- В PowerShell 5.1 передавай сообщение коммита файлом (`git commit -F msg.txt`): двойные кавычки в аргументах нативных программ теряются.
- Новый инструмент агента: файл в `server/src/modules/agent/tools/`, `defineTool` + zod-схема, правильный `kind` (от него зависят разрешения и снапшоты), регистрация в `Container`, имя в нужных профилях (`profiles.ts`), тесты.
