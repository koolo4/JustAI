import type * as Monaco from "monaco-editor";

import { apiFetch } from "../services/http";

const DEBOUNCE_MS = 350;
let registered = false;

/** Подождать паузу в наборе; false — запрос уже не нужен (курсор ушёл, набран новый символ). */
function pause(token: Monaco.CancellationToken): Promise<boolean> {
    return new Promise(resolve => {
        const timer = setTimeout(() => resolve(!token.isCancellationRequested), DEBOUNCE_MS);
        token.onCancellationRequested(() => {
            clearTimeout(timer);
            resolve(false);
        });
    });
}

/**
 * Подсказки серым текстом от локальной модели (fill-in-the-middle через сервер). Tab — принять.
 * Регистрируется один раз для всех языков; если модель выключена или недоступна — подсказок просто нет.
 */
export function registerAiCompletion(monaco: typeof Monaco): void {
    if (registered) {
        return;
    }

    registered = true;

    monaco.languages.registerInlineCompletionsProvider({ pattern: "**" }, {
        async provideInlineCompletions(model, position, _context, token) {
            if (!(await pause(token))) {
                return { items: [] };
            }

            const end = model.getFullModelRange().getEndPosition();
            const prefix = model.getValueInRange(new monaco.Range(1, 1, position.lineNumber, position.column));
            const suffix = model.getValueInRange(new monaco.Range(position.lineNumber, position.column, end.lineNumber, end.column));

            // Нечего дополнять: пустой файл или курсор посреди слова справа.
            if (!prefix.trim() || /^\w/.test(suffix)) {
                return { items: [] };
            }

            const controller = new AbortController();
            token.onCancellationRequested(() => controller.abort());

            try {
                const response = await apiFetch("/completion", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ path: model.uri.path.replace(/^\//, ""), prefix, suffix }),
                    signal: controller.signal,
                });

                const { completion } = await response.json() as { completion?: string };

                if (!completion || token.isCancellationRequested) {
                    return { items: [] };
                }

                return {
                    items: [{
                        insertText: completion,
                        range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
                    }],
                };
            }
            catch {
                return { items: [] };
            }
        },
        disposeInlineCompletions() {
            // ресурсов нет
        },
    });
}
