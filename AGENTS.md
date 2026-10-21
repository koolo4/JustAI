# AGENTS.md — инструкции для ИИ-агентов

Главный документ проекта: **[docs/MASTER_PLAN.md](docs/MASTER_PLAN.md)**.
Перед любой работой прочитай в нём разделы 1–6 и 9, затем возьми первую задачу `TODO` из раздела 7, у которой выполнены зависимости.

## Структура
- `server/` — backend (Node 22, TypeScript, Express, ESM)
- `apps/web/` — frontend (React + Vite)
- `packages/shared/` — общие типы (создаётся в задаче P1-01)
- `docs/` — документация, ADR (`docs/decisions.md`), changelog

## Команды
```bash
cd server; npm install; npm run dev      # сервер на http://localhost:4302
cd apps/web; npm install; npm run dev    # фронт на http://localhost:3000
```
Скрипты `test` и `typecheck` появятся в задаче P0-03. До этого сборка сервера может быть сломана (см. P0-02).

## Правила
- Одна задача плана за раз; по завершении обнови статус задачи и журнал (раздел 11 плана).
- Не коммить `.env`, ключи и содержимое `.justai/`.
- Не ослабляй проверки путей и разрешений ради прохождения тестов.
