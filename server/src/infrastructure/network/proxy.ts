import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

/** Локальные адреса (Ollama, LM Studio, сам сервер) всегда идут мимо прокси. */
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]"];

export interface ProxySettings {
    url: string;
    noProxy: string;
}

/**
 * Читает JUSTAI_PROXY (например, http://127.0.0.1:10809). Пусто — прокси не используется.
 * JUSTAI_NO_PROXY добавляет хосты-исключения к локальным.
 */
export function readProxySettings(env: NodeJS.ProcessEnv): ProxySettings | undefined {
    const raw = env.JUSTAI_PROXY?.trim();

    if (!raw) {
        return undefined;
    }

    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
    new URL(url); // бросит понятную ошибку на опечатке

    const extra = (env.JUSTAI_NO_PROXY ?? "")
        .split(",")
        .map(host => host.trim())
        .filter(Boolean);

    return { url, noProxy: [...LOCAL_HOSTS, ...extra].join(",") };
}

/**
 * Направляет все fetch-запросы сервера (облачные провайдеры, web_fetch) через прокси.
 * Нужно, когда провайдер недоступен напрямую (например, Groq отвечает 403 по региону).
 */
export function configureProxy(env: NodeJS.ProcessEnv): ProxySettings | undefined {
    const settings = readProxySettings(env);

    if (settings) {
        setGlobalDispatcher(new EnvHttpProxyAgent({
            httpProxy: settings.url,
            httpsProxy: settings.url,
            noProxy: settings.noProxy,
        }));
    }

    return settings;
}
