import { useEffect, useMemo, useState } from "react";

import type { ProviderInfo, SettingField, SettingsResponse } from "@justai/shared";

import { fetchProviders } from "../services/agentApi";
import { apiFetch, readApiError, waitForServer } from "../services/http";

interface Props {
    onClose(): void;
}

const SOURCE_LABEL: Record<SettingField["source"], string> = {
    ui: "set here",
    env: "from server/.env",
    default: "not set",
};

/**
 * Настройки сервера: провайдеры, ключи, модели, резервы, прокси.
 * Ключи сервер не отдаёт: поле пустое — значит «оставить как есть».
 */
export function SettingsPanel({ onClose }: Props) {
    const [settings, setSettings] = useState<SettingsResponse | null>(null);
    const [providers, setProviders] = useState<ProviderInfo[]>([]);
    const [changes, setChanges] = useState<Record<string, string | null>>({});
    const [filter, setFilter] = useState("");
    const [error, setError] = useState("");
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        apiFetch("/settings")
            .then(async response => response.ok ? setSettings(await response.json() as SettingsResponse) : setError(await readApiError(response)))
            .catch(reason => setError(String(reason)));

        fetchProviders()
            .then(result => setProviders(result.providers))
            .catch(() => undefined);
    }, []);

    const groups = useMemo(() => {
        const needle = filter.trim().toLowerCase();
        const map = new Map<string, SettingField[]>();

        for (const field of settings?.fields ?? []) {
            if (needle && !`${field.group} ${field.label} ${field.key}`.toLowerCase().includes(needle)) {
                continue;
            }

            map.set(field.group, [...map.get(field.group) ?? [], field]);
        }

        return [...map.entries()];
    }, [settings, filter]);

    const dirty = Object.keys(changes).length;

    function change(key: string, value: string | null) {
        setChanges(current => ({ ...current, [key]: value }));
    }

    function revertEdit(key: string) {
        setChanges(current => {
            const next = { ...current };
            delete next[key];
            return next;
        });
    }

    async function save() {
        setError("");
        setSaving(true);

        try {
            const response = await apiFetch("/settings", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ values: changes }),
            });

            if (!response.ok) {
                throw new Error(await readApiError(response));
            }

            await waitForServer();
            // Провайдеры, модели и прокси применяются при пересборке сервера — обновляем всё.
            window.location.reload();
        }
        catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
            setSaving(false);
        }
    }

    return (
        <div className="settings-panel">
            <div className="diff-header">
                <div>
                    <strong>Settings</strong>
                    <span className="muted"> — stored in .justai/settings.json, override server/.env</span>
                </div>
                <div className="diff-actions">
                    <input
                        className="settings-filter"
                        placeholder="Filter"
                        value={filter}
                        onChange={event => setFilter(event.target.value)}
                    />
                    <button className="allow-button" disabled={!dirty || saving} onClick={() => void save()}>
                        {saving ? "Applying…" : dirty ? `Save (${dirty})` : "Save"}
                    </button>
                    <button className="secondary-button" onClick={onClose} disabled={saving}>Close</button>
                </div>
            </div>

            {error && <div className="error">{error}</div>}
            {!settings && !error && <div className="muted settings-loading">Loading settings…</div>}

            <div className="settings-body">
                <McpStatus />

                {groups.map(([group, fields]) => (
                    <section key={group} className="settings-group">
                        <h3>{group}</h3>

                        {fields.map(field => (
                            <SettingRow
                                key={field.key}
                                field={field}
                                providers={providers}
                                edit={field.key in changes ? changes[field.key] : undefined}
                                onChange={value => change(field.key, value)}
                                onRevertEdit={() => revertEdit(field.key)}
                            />
                        ))}
                    </section>
                ))}
            </div>
        </div>
    );
}

interface McpInfo {
    configFiles: string[];
    servers: Array<{ name: string; status: "connected" | "failed" | "disabled"; tools: string[]; error?: string }>;
}

/** MCP-серверы: только просмотр; настраиваются файлом .justai/mcp.json. */
function McpStatus() {
    const [info, setInfo] = useState<McpInfo | null>(null);

    useEffect(() => {
        apiFetch("/agent/mcp")
            .then(async response => response.ok ? setInfo(await response.json() as McpInfo) : undefined)
            .catch(() => undefined);
    }, []);

    if (!info) {
        return null;
    }

    return (
        <section className="settings-group">
            <h3>MCP servers</h3>
            {info.servers.length === 0 && (
                <p className="muted setting-hint">
                    No MCP servers. Describe them in <code>{info.configFiles.at(-1)}</code> as
                    {" "}<code>{"{ \"mcpServers\": { \"name\": { \"command\": \"npx\", \"args\": [\"…\"] } } }"}</code> and restart the server.
                </p>
            )}
            {info.servers.map(server => (
                <div key={server.name} className="setting-row">
                    <span className="setting-label">{server.name}</span>
                    <span className={server.status === "failed" ? "error-text" : "muted"}>
                        {server.status === "connected" ? `${server.tools.length} tool(s)` : server.status}
                        {server.error ? `: ${server.error}` : ""}
                    </span>
                    <span className="setting-meta muted">{server.status}</span>
                </div>
            ))}
        </section>
    );
}

interface RowProps {
    field: SettingField;
    providers: ProviderInfo[];
    /** undefined — без правок, null — сбросить к .env, строка — новое значение. */
    edit: string | null | undefined;
    onChange(value: string | null): void;
    onRevertEdit(): void;
}

function SettingRow({ field, providers, edit, onChange, onRevertEdit }: RowProps) {
    const secret = field.kind === "secret";
    // У секретов в поле только то, что ввели сейчас; маска — подсказкой.
    const shown = edit ?? (secret ? "" : field.value);
    const placeholder = secret ? (field.isSet ? `${field.value} (leave empty to keep)` : "not set") : field.placeholder ?? "";

    return (
        <label className={`setting-row${edit !== undefined ? " edited" : ""}`}>
            <span className="setting-label">
                {field.label}
                <code className="muted">{field.key}</code>
            </span>

            {field.kind === "provider" ? (
                <select value={shown ?? ""} onChange={event => onChange(event.target.value)}>
                    <option value="">(default)</option>
                    {providers.map(provider => (
                        <option key={provider.id} value={provider.id}>
                            {provider.label}{provider.configured ? "" : " — not configured"}
                        </option>
                    ))}
                </select>
            ) : (
                <input
                    type={secret ? "password" : field.kind === "number" ? "number" : "text"}
                    autoComplete="off"
                    value={shown ?? ""}
                    placeholder={placeholder}
                    onChange={event => secret && !event.target.value ? onRevertEdit() : onChange(event.target.value)}
                />
            )}

            <span className="setting-meta muted">
                {edit === null ? "will reset to server/.env" : edit !== undefined ? "changed" : SOURCE_LABEL[field.source]}
                {edit !== undefined && <button type="button" className="link-button" onClick={onRevertEdit}>undo</button>}
                {edit === undefined && field.source === "ui" && (
                    <button type="button" className="link-button" onClick={() => onChange(null)}>reset</button>
                )}
            </span>
        </label>
    );
}
