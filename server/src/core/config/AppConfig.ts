export interface AppConfig {

    port: number;

    /** Интерфейс, на котором слушает сервер. По умолчанию только loopback. */
    host: string;

    nodeEnv: string;

    workspacePath: string;

    /** Origin'ы фронта, которым разрешён доступ к API. */
    allowedOrigins: string[];

}
