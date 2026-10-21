import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer, IncomingMessage } from 'node:http';

export class WebSocketConnectionManager {

    private server?: WebSocketServer;

    private readonly clients =
        new Set<WebSocket>();

    public attach(
        httpServer: HttpServer,
        verify: (request: IncomingMessage) => boolean,
    ): void {

        this.server = new WebSocketServer({
            server: httpServer,
            verifyClient: (info: { req: IncomingMessage }) => verify(info.req),
        });

        this.server.on(
            'connection',
            (socket) => {

                this.clients.add(socket);

                socket.on(
                    'close',
                    () => {
                        this.clients.delete(socket);
                    },
                );

                socket.on(
                    'error',
                    () => {
                        this.clients.delete(socket);
                    },
                );

            },
        );

    }

    public broadcast(
        message: unknown,
    ): void {

        const payload =
            JSON.stringify(message);

        for (const client of this.clients) {

            if (
                client.readyState === WebSocket.OPEN
            ) {

                client.send(payload);

            }

        }

    }

    public getClientCount(): number {

        return this.clients.size;

    }

}