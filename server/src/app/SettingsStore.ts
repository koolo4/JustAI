import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { SettingField, SettingsResponse } from "@justai/shared";

import { BadRequestError } from "../core/errors/BadRequestError.js";
import { COMPATIBLE_PRESETS } from "../modules/agent/providers/compatiblePresets.js";

type FieldSpec = Omit<SettingField, "value" | "isSet" | "source">;

/** Переменные, которые можно менять из интерфейса. Остальное — только в server/.env. */
export function settingFields(): FieldSpec[] {
    const fields: FieldSpec[] = [
        { key: "JUSTAI_PROVIDER", label: "Default provider", group: "Agents", kind: "provider" },
        { key: "JUSTAI_EXECUTOR_PROVIDER", label: "Executor provider (planner mode)", group: "Agents", kind: "provider" },
        { key: "JUSTAI_SUBAGENT_PROVIDER", label: "Helper agents provider (explore/review)", group: "Agents", kind: "provider" },

        { key: "ANTHROPIC_API_KEY", label: "API key", group: "Anthropic", kind: "secret" },
        { key: "ANTHROPIC_MODEL", label: "Model", group: "Anthropic", kind: "text" },
        { key: "OPENAI_API_KEY", label: "API key", group: "OpenAI", kind: "secret" },
        { key: "OPENAI_MODEL", label: "Model", group: "OpenAI", kind: "text" },
    ];

    for (const preset of COMPATIBLE_PRESETS) {
        const group = preset.label;
        const keyName = preset.keyEnv[0];

        if (keyName) {
            fields.push({ key: keyName, label: "API key", group, kind: "secret" });
        }

        fields.push({ key: `${preset.prefix}_MODEL`, label: "Model", group, kind: "text", ...(preset.defaultModel ? { placeholder: preset.defaultModel } : {}) });

        if (preset.local || !preset.baseURL) {
            fields.push({ key: `${preset.prefix}_BASE_URL`, label: "Base URL", group, kind: "text", ...(preset.baseURL ? { placeholder: preset.baseURL } : { placeholder: "https://…/v1" }) });
        }

        fields.push({ key: `${preset.prefix}_CONTEXT`, label: "Context window (tokens)", group, kind: "number", placeholder: String(preset.contextTokens) });

        if (preset.local) {
            fields.push({ key: `${preset.prefix}_REASONING_EFFORT`, label: "Reasoning effort (none = no thinking)", group, kind: "text" });
        }
    }

    fields.push(
        { key: "JUSTAI_EMBED_PROVIDER", label: "Embeddings provider (search_code)", group: "Code search", kind: "provider" },
        { key: "JUSTAI_EMBED_MODEL", label: "Embeddings model", group: "Code search", kind: "text", placeholder: "nomic-embed-text" },
        { key: "JUSTAI_RESERVE_COOLDOWN_SEC", label: "Return to the main provider after (seconds)", group: "Reserves", kind: "number", placeholder: "120" },
        { key: "JUSTAI_PROXY", label: "HTTP proxy for cloud providers", group: "Network", kind: "text", placeholder: "http://127.0.0.1:10809" },
        { key: "JUSTAI_NO_PROXY", label: "Hosts without proxy (comma separated)", group: "Network", kind: "text" },
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
                throw new BadRequestError(`Setting ${key} cannot be changed from the interface.`);
            }

            if (value === null) {
                delete saved[key];
                continue;
            }

            const trimmed = value.trim();

            if (field.kind === "number" && trimmed && !(Number(trimmed) > 0)) {
                throw new BadRequestError(`${field.group} · ${field.label}: enter a positive number.`);
            }

            if (/[\r\n]/.test(trimmed)) {
                throw new BadRequestError(`${field.group} · ${field.label}: line breaks are not allowed.`);
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
