import { Agent, EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

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
 * Адрес в домашней/локальной сети: 10.*, 172.16–31.*, 192.168.*, 169.254.*, IPv6 fc00::/7 и fe80::,
 * имена *.local и имена без точки (имя компьютера в сети). Такие запросы (Ollama или GPT-ретранслятор
 * на соседнем ПК) не должны уходить в прокси — он их не доставит.
 */
export function isPrivateNetworkHost(host: string): boolean {
    const name = host.replace(/^\[|\]$/g, "").toLowerCase();

    if (LOCAL_HOSTS.includes(name) || name.endsWith(".local") || name.endsWith(".lan") || name.endsWith(".home.arpa")) {
        return true;
    }

    const ipv4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(name);

    if (ipv4) {
        const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
        return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
    }

    if (name.includes(":")) {
        return /^(fc|fd|fe8|fe9|fea|feb)/.test(name);
    }

    return !name.includes(".");
}

/**
 * Направляет все fetch-запросы сервера (облачные провайдеры, web_fetch) через прокси.
 * Нужно, когда провайдер недоступен напрямую (например, Groq отвечает 403 по региону).
 * Адреса локальной сети всегда идут напрямую.
 */
export function configureProxy(env: NodeJS.ProcessEnv): ProxySettings | undefined {
    const settings = readProxySettings(env);

    if (!settings) {
        // Без прокси — обычный агент: настройку можно выключить из интерфейса без перезапуска процесса.
        setGlobalDispatcher(new Agent());
        return settings;
    }

    const direct = new Agent();
    const proxied = new EnvHttpProxyAgent({
        httpProxy: settings.url,
        httpsProxy: settings.url,
        noProxy: settings.noProxy,
    });

    setGlobalDispatcher(proxied.compose(dispatch => (options, handler) => {
        const origin = typeof options.origin === "string" ? options.origin : options.origin?.toString() ?? "";
        let host = "";

        try {
            host = new URL(origin).hostname;
        }
        catch {
            // нет origin — обычный путь
        }

        return host && isPrivateNetworkHost(host) ? direct.dispatch(options, handler) : dispatch(options, handler);
    }));

    return settings;
}
