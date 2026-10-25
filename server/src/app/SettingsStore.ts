import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { SettingField, SettingsResponse } from "@justai/shared";

import { BadRequestError } from "../core/errors/BadRequestError.js";
import { COMPATIBLE_PRESETS } from "../modules/agent/providers/compatiblePresets.js";

type FieldSpec = Omit<SettingField, "value" | "isSet" | "source">;

/** Переменные, которые можно менять из интерфейса. Остальное — только в server/.env. */
export function settingFields(): FieldSpec[] {
    const fields: FieldSpec[] = [
        { key: "JUSTAI_PROVIDER", label: "Провайдер по умолчанию", group: "Агенты", kind: "provider" },
        { key: "JUSTAI_EXECUTOR_PROVIDER", label: "Исполнитель (режим планировщика)", group: "Агенты", kind: "provider" },
        { key: "JUSTAI_SUBAGENT_PROVIDER", label: "Помощники-агенты (разведка, ревью)", group: "Агенты", kind: "provider" },

        { key: "ANTHROPIC_API_KEY", label: "API-ключ", group: "Anthropic", kind: "secret" },
        { key: "ANTHROPIC_MODEL", label: "Модель", group: "Anthropic", kind: "text" },
        { key: "OPENAI_API_KEY", label: "API-ключ", group: "OpenAI", kind: "secret" },
        { key: "OPENAI_MODEL", label: "Модель", group: "OpenAI", kind: "text" },
    ];

    for (const preset of COMPATIBLE_PRESETS) {
        const group = preset.label;
        const keyName = preset.keyEnv[0];

        if (keyName) {
            fields.push({ key: keyName, label: "API-ключ", group, kind: "secret" });
        }

        fields.push({ key: `${preset.prefix}_MODEL`, label: "Модель", group, kind: "text", ...(preset.defaultModel ? { placeholder: preset.defaultModel } : {}) });

        if (preset.local || !preset.baseURL) {
            fields.push({ key: `${preset.prefix}_BASE_URL`, label: "Адрес сервера (Base URL)", group, kind: "text", ...(preset.baseURL ? { placeholder: preset.baseURL } : { placeholder: "https://…/v1" }) });
        }

        fields.push({ key: `${preset.prefix}_CONTEXT`, label: "Окно контекста (токены)", group, kind: "number", placeholder: String(preset.contextTokens) });

        if (preset.local) {
            fields.push({ key: `${preset.prefix}_REASONING_EFFORT`, label: "Размышления (none — выключить)", group, kind: "text" });
        }
    }

    fields.push(
        { key: "JUSTAI_GITHUB_TOKEN", label: "Токен GitHub (fine-grained: Issues, Pull requests, Contents — чтение и запись)", group: "GitHub", kind: "secret" },
        { key: "JUSTAI_GITHUB_REPO", label: "Репозиторий (владелец/имя)", group: "GitHub", kind: "text", placeholder: "user/my-project" },
        { key: "JUSTAI_GITHUB_RUNNER", label: "Брать задачи из GitHub на этом ПК (on/off)", group: "GitHub", kind: "text", placeholder: "off" },
        { key: "JUSTAI_GITHUB_PROVIDER", label: "Кто выполняет задачи", group: "GitHub", kind: "provider" },
        { key: "JUSTAI_GITHUB_PROFILE", label: "Профиль исполнителя (coder или planner)", group: "GitHub", kind: "text", placeholder: "coder" },
        { key: "JUSTAI_GITHUB_LABEL", label: "Метка задач", group: "GitHub", kind: "text", placeholder: "justai" },
        { key: "JUSTAI_GITHUB_ALLOWED_USERS", label: "Кто может ставить задачи (логины через запятую; пусто — владелец токена)", group: "GitHub", kind: "text" },
        { key: "JUSTAI_GITHUB_ALLOW_PUBLIC", label: "Разрешить публичный репозиторий (on/off; задачи всё равно только от разрешённых авторов)", group: "GitHub", kind: "text", placeholder: "off" },
        { key: "JUSTAI_GITHUB_MERGE", label: "Сливать PR по команде «/justai merge», если проверки зелёные (on/off)", group: "GitHub", kind: "text", placeholder: "on" },
        { key: "JUSTAI_GITHUB_MERGE_METHOD", label: "Способ слияния (squash, merge или rebase)", group: "GitHub", kind: "text", placeholder: "squash" },
        { key: "JUSTAI_KEEP_AWAKE", label: "Не давать ПК уснуть (task — пока идёт задача, always — пока включён мост, off)", group: "GitHub", kind: "text", placeholder: "task" },
        { key: "JUSTAI_GITHUB_AUTO_STASH", label: "Незакоммиченные файлы перед задачей убирать в git stash (on) или ждать (off)", group: "GitHub", kind: "text", placeholder: "on" },
        { key: "JUSTAI_APP_IDLE_MIN", label: "Остановить приложение («/justai app start») после минут без обращений", group: "GitHub", kind: "number", placeholder: "30" },
        { key: "JUSTAI_GITHUB_POLL_SEC", label: "Проверять новые задачи каждые (секунд)", group: "GitHub", kind: "number", placeholder: "60" },
        { key: "JUSTAI_COMPLETION_MODEL", label: "Модель подсказок по Tab в Ollama (off — выключить)", group: "Редактор", kind: "text", placeholder: "qwen2.5-coder:7b" },
        { key: "JUSTAI_EMBED_PROVIDER", label: "Провайдер эмбеддингов (поиск по смыслу)", group: "Поиск по коду", kind: "provider" },
        { key: "JUSTAI_EMBED_MODEL", label: "Модель эмбеддингов", group: "Поиск по коду", kind: "text", placeholder: "nomic-embed-text" },
        { key: "JUSTAI_LAST_RESORT", label: "Последний резерв — локальная модель без лимитов (ollama, lmstudio или off)", group: "Резервы", kind: "text", placeholder: "ollama" },
        { key: "JUSTAI_RESERVE_COOLDOWN_SEC", label: "Вернуться к главному провайдеру через (секунд)", group: "Резервы", kind: "number", placeholder: "120" },
        { key: "JUSTAI_PROXY", label: "HTTP-прокси для облачных провайдеров", group: "Сеть", kind: "text", placeholder: "http://127.0.0.1:10809" },
        { key: "JUSTAI_NO_PROXY", label: "Адреса без прокси (через запятую)", group: "Сеть", kind: "text" },
    );

    return fields;
}

/**
 * Настройки из интерфейса: `.justai/settings.json` папки установки, поверх server/.env.
 * Значения применяются к process.env, исходный env запоминается, чтобы «сбросить» вернуло значение из .env.
 */
export class SettingsStore {

    private readonly file: string;
    private readonly fields = new Map(settingFields().map(field => [field.key, field]));
    private readonly baseEnv: Record<string, string | undefined>;

    constructor(installRoot: string, private readonly env: NodeJS.ProcessEnv = process.env) {
        this.file = path.join(installRoot, ".justai", "settings.json");
        this.baseEnv = Object.fromEntries([...this.fields.keys()].map(key => [key, env[key]]));
    }

    /** Применить сохранённые значения к env (при старте сервера). */
    public apply(): void {
        const saved = this.read();

        for (const key of this.fields.keys()) {
            const value = saved[key] ?? this.baseEnv[key];

            if (value === undefined || value === "") {
                delete this.env[key];
            }
            else {
                this.env[key] = value;
            }
        }
    }

    public view(): SettingsResponse {
        const saved = this.read();

        return {
            fields: [...this.fields.values()].map(field => {
                const value = this.env[field.key] ?? "";
                const source = saved[field.key] !== undefined ? "ui" : value ? "env" : "default";

                return {
                    ...field,
                    isSet: value !== "",
                    source,
                    // Ключи наружу не отдаём: только последние символы, чтобы узнать, какой стоит.
                    value: field.kind === "secret" ? (value ? `••••${value.slice(-4)}` : "") : value,
                };
            }),
        };
    }

    /**
     * `null` — убрать значение из интерфейса (вернётся значение из .env), строка — задать.
     * Неизвестные ключи — ошибка: из интерфейса нельзя менять произвольные переменные.
     */
    public update(values: Record<string, string | null>): void {
        const saved = this.read();

        for (const [key, value] of Object.entries(values)) {
            const field = this.fields.get(key);

            if (!field) {
                throw new BadRequestError(`Настройку ${key} нельзя менять из интерфейса.`);
            }

            if (value === null) {
                delete saved[key];
                continue;
            }

            const trimmed = value.trim();

            if (field.kind === "number" && trimmed && !(Number(trimmed) > 0)) {
                throw new BadRequestError(`${field.group} · ${field.label}: введите положительное число.`);
            }

            if (/[\r\n]/.test(trimmed)) {
                throw new BadRequestError(`${field.group} · ${field.label}: переносы строк недопустимы.`);
            }

            saved[key] = trimmed;
        }

        this.write(saved);
        this.apply();
    }

    private read(): Record<string, string> {
        try {
            const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, unknown>;
            return Object.fromEntries(
                Object.entries(parsed).filter((entry): entry is [string, string] => this.fields.has(entry[0]) && typeof entry[1] === "string"),
            );
        }
        catch {
            return {};
        }
    }

    private write(values: Record<string, string>): void {
        mkdirSync(path.dirname(this.file), { recursive: true });
        writeFileSync(this.file, JSON.stringify(values, null, 2), { encoding: "utf8", mode: 0o600 });
    }
}
