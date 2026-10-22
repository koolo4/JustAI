export const API_URL: string =
    import.meta.env.VITE_API_URL ??
    "http://localhost:4302/api";

let tokenPromise: Promise<string> | null = null;

/**
 * Токен доступа к локальному серверу. Сервер выдаёт его только разрешённому Origin фронта.
 * После перезапуска сервера токен меняется — тогда кэш сбрасывается через resetToken().
 */
export function getToken(): Promise<string> {
    if (!tokenPromise) {
        tokenPromise = fetch(`${API_URL}/auth/token`)
            .then(async response => {
                if (!response.ok) {
                    throw new Error(`Failed to get access token: ${response.status}`);
                }

                const json = await response.json() as { token: string };
                return json.token;
            })
            .catch(error => {
                tokenPromise = null;
                throw error;
            });
    }

    return tokenPromise;
}

export function resetToken(): void {
    tokenPromise = null;
}

/**
 * fetch к API с Bearer-токеном. При 401 один раз получает новый токен и повторяет запрос.
 */
export async function apiFetch(
    path: string,
    init: RequestInit = {},
): Promise<Response> {
    const send = async () => {
        const headers = new Headers(init.headers);
        headers.set("Authorization", `Bearer ${await getToken()}`);

        return fetch(`${API_URL}${path}`, { ...init, headers });
    };

    const response = await send();

    if (response.status !== 401) {
        return response;
    }

    resetToken();
    return send();
}

/** Текст ошибки API ({ error: { message } }) или статус. */
export async function readApiError(response: Response): Promise<string> {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    return body?.error?.message ?? `${response.status} ${response.statusText}`;
}

/** Ждём, пока сервер поднимется после перезапуска (смена папки или настроек). */
export async function waitForServer(): Promise<void> {
    for (let attempt = 0; attempt < 60; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 500));

        try {
            if ((await fetch(`${API_URL}/health`)).ok) {
                return;
            }
        }
        catch {
            // сервер ещё перезапускается
        }
    }

    throw new Error("The server did not come back after the restart.");
}

/**
 * URL WebSocket с токеном: браузерный WebSocket не умеет ставить заголовки.
 */
export async function getSocketUrl(): Promise<string> {
    const base = new URL(API_URL);
    base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    base.pathname = "/";
    base.search = `?token=${encodeURIComponent(await getToken())}`;

    return base.toString();
}
