import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

const TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
};

/**
 * Встроенный статический сервер для сайтов без сборки (index.html в корне): не нужен ни python, ни npm.
 * Только 127.0.0.1, только файлы внутри папки (без выхода через «..»), без листинга папок.
 */
export class StaticServer {

    private server?: http.Server;

    constructor(private readonly root: string) {}

    public async start(): Promise<string> {
        const root = path.resolve(this.root);

        this.server = http.createServer((request, response) => {
            void (async () => {
                const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
                let file = path.resolve(root, `.${pathname}`);

                if (file !== root && !file.startsWith(root + path.sep)) {
                    response.writeHead(403).end();
                    return;
                }

                try {
                    if ((await stat(file)).isDirectory()) file = path.join(file, "index.html");
                    await stat(file);
                }
                catch {
                    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
                    return;
                }

                response.writeHead(200, {
                    "Content-Type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
                    "Cache-Control": "no-store",
                });
                createReadStream(file).pipe(response);
            })().catch(() => response.writeHead(500).end());
        });

        await new Promise<void>((resolve, reject) => {
            this.server!.once("error", reject);
            this.server!.listen(0, "127.0.0.1", resolve);
        });

        return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/`;
    }

    public async stop(): Promise<void> {
        const server = this.server;
        this.server = undefined;
        if (!server) return;
        // Браузер держит соединения открытыми (keep-alive) — без этого close ждал бы их бесконечно.
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
}
