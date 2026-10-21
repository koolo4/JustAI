import { getSocketUrl, resetToken } from "./http";

export type SocketStatus = "connecting" | "open" | "closed";

type MessageListener = (message: unknown) => void;
type StatusListener = (status: SocketStatus) => void;

const RECONNECT_DELAY_MS = 2000;

/**
 * Одно WebSocket-соединение на приложение: события файлов и агента идут по нему же.
 * Подключается при первом подписчике и переподключается после обрыва (новый токен после рестарта сервера).
 */
class SocketBus {

    private socket: WebSocket | null = null;

    private status: SocketStatus = "closed";

    private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    private readonly messageListeners = new Set<MessageListener>();

    private readonly statusListeners = new Set<StatusListener>();

    public subscribe(listener: MessageListener): () => void {
        this.messageListeners.add(listener);
        this.ensureConnected();

        return () => {
            this.messageListeners.delete(listener);
        };
    }

    public onStatus(listener: StatusListener): () => void {
        this.statusListeners.add(listener);
        listener(this.status);
        this.ensureConnected();

        return () => {
            this.statusListeners.delete(listener);
        };
    }

    private ensureConnected(): void {
        if (this.socket || this.reconnectTimer) {
            return;
        }

        void this.connect();
    }

    private async connect(): Promise<void> {
        this.setStatus("connecting");

        let url: string;

        try {
            url = await getSocketUrl();
        }
        catch {
            this.scheduleReconnect();
            return;
        }

        const socket = new WebSocket(url);
        this.socket = socket;

        socket.onopen = () => this.setStatus("open");

        socket.onmessage = event => {
            let parsed: unknown;

            try {
                parsed = JSON.parse(String(event.data));
            }
            catch {
                return;
            }

            for (const listener of this.messageListeners) {
                listener(parsed);
            }
        };

        socket.onclose = () => {
            this.socket = null;
            this.scheduleReconnect();
        };
    }

    private scheduleReconnect(): void {
        this.setStatus("closed");
        resetToken();

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            void this.connect();
        }, RECONNECT_DELAY_MS);
    }

    private setStatus(status: SocketStatus): void {
        this.status = status;

        for (const listener of this.statusListeners) {
            listener(status);
        }
    }
}

export const socketBus = new SocketBus();
