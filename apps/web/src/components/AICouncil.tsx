import { useEffect, useMemo, useState } from "react";

import {
    connectCouncilProvider,
    fetchCouncilStatus,
    runCouncil,
    type CouncilProviderId,
    type CouncilProviderStatus,
    type CouncilRunResponse,
} from "../services/councilApi";

import { useIDEContext } from "../context/useIDEContext";

const ALL: CouncilProviderId[] = ["chatgpt", "claude", "deepseek"];

const LABELS: Record<CouncilProviderId, string> = {
    chatgpt: "ChatGPT",
    claude: "Claude",
    deepseek: "DeepSeek",
};

const DEFAULT_ROLES: Record<CouncilProviderId, string> = {
    chatgpt: "architect",
    claude: "critic",
    deepseek: "implementer",
};

export function AICouncil() {
    const { activeFile, activeContent, projectTree } = useIDEContext();
    const [statuses, setStatuses] = useState<CouncilProviderStatus[]>([]);
    const [selected, setSelected] = useState<CouncilProviderId[]>(ALL);
    const [chair, setChair] = useState<CouncilProviderId>("chatgpt");
    const [roles, setRoles] = useState<Record<CouncilProviderId, string>>(DEFAULT_ROLES);
    const [prompt, setPrompt] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [result, setResult] = useState<CouncilRunResponse | null>(null);

    async function refresh() {
        try {
            setStatuses(await fetchCouncilStatus());
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        }
    }

    useEffect(() => {
        void refresh();
    }, []);

    const statusMap = useMemo(
        () => new Map(statuses.map(item => [item.id, item])),
        [statuses],
    );

    function toggleProvider(id: CouncilProviderId) {
        setSelected(previous => {
            if (previous.includes(id)) {
                const next = previous.filter(item => item !== id);
                if (chair === id && next.length) setChair(next[0]);
                return next;
            }
            return [...previous, id];
        });
    }

    async function connect(id: CouncilProviderId) {
        setError("");
        try {
            await connectCouncilProvider(id);
            await refresh();
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        }
    }

    async function run() {
        if (!prompt.trim() || loading || !selected.length) return;
        if (!selected.includes(chair)) {
            setError("Председатель должен быть выбран в составе совета.");
            return;
        }

        setLoading(true);
        setError("");
        try {
            const response = await runCouncil({
                prompt: prompt.trim(),
                providers: selected,
                chair,
                roles,
                projectContext: JSON.stringify(projectTree, null, 2),
                activeFile,
                activeContent,
            });
            setResult(response);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        } finally {
            setLoading(false);
        }
    }

    return (
        <section className="council-card">
            <div className="council-title">
                <div>
                    <h3>AI Council</h3>
                    <div className="muted">Советуется с твоими веб-аккаунтами без API-ключей</div>
                </div>
                <button className="secondary-button" onClick={() => void refresh()}>Обновить</button>
            </div>

            <div className="council-providers">
                {ALL.map(id => {
                    const status = statusMap.get(id);
                    return (
                        <div className="council-provider" key={id}>
                            <label>
                                <input
                                    type="checkbox"
                                    checked={selected.includes(id)}
                                    onChange={() => toggleProvider(id)}
                                />
                                <strong>{LABELS[id]}</strong>
                            </label>
                            <span className={status?.connected ? "council-ok" : "council-off"}>
                                {status?.connected ? "вошёл" : "не подключён"}
                            </span>
                            <select
                                value={roles[id]}
                                disabled={!selected.includes(id)}
                                onChange={event => setRoles(previous => ({ ...previous, [id]: event.target.value }))}
                            >
                                <option value="architect">Архитектор</option>
                                <option value="critic">Критик</option>
                                <option value="implementer">Разработчик</option>
                                <option value="researcher">Исследователь</option>
                            </select>
                            <button className="secondary-button" onClick={() => void connect(id)}>
                                {status?.open ? "Открыть" : "Подключить"}
                            </button>
                        </div>
                    );
                })}
            </div>

            <div className="council-chair">
                <label>
                    Председатель:
                    <select value={chair} onChange={event => setChair(event.target.value as CouncilProviderId)}>
                        {selected.map(id => <option key={id} value={id}>{LABELS[id]}</option>)}
                    </select>
                </label>
                <span className="muted">Председатель получает ответы остальных и собирает единый план.</span>
            </div>

            <textarea
                rows={4}
                value={prompt}
                onChange={event => setPrompt(event.target.value)}
                placeholder="Например: изучите текущий проект, найдите архитектурные проблемы и решите, как реализовать автоматическое управление кодом."
            />

            <button className="primary-button" onClick={() => void run()} disabled={loading || !prompt.trim() || !selected.length}>
                {loading ? "Совет совещается…" : "Созвать AI Council"}
            </button>

            {error && <div className="error">{error}</div>}

            <div className="council-note">
                Первый запуск каждого AI откроет отдельное окно браузера. Войди там в свой аккаунт один раз. Пароли и cookies не передаются JustAI API и не записываются в его базу.
            </div>

            {result && (
                <div className="council-result">
                    <h4>Мнения советников</h4>
                    {result.opinions.map(opinion => (
                        <details key={`${opinion.provider}-${opinion.role}`} open>
                            <summary>{LABELS[opinion.provider]} — {opinion.role}</summary>
                            <pre>{opinion.answer}</pre>
                        </details>
                    ))}
                    <h4>Решение председателя — {LABELS[result.chair.provider]}</h4>
                    <pre>{result.chair.answer}</pre>
                    <div className="notice">{result.executionPolicy}</div>
                </div>
            )}
        </section>
    );
}
