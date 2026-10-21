import { AppConfig } from './AppConfig.js';

const DEFAULT_ALLOWED_ORIGINS = [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
];

export class ConfigService {

    private readonly config: AppConfig;

    constructor() {

        this.config = {

            port:
                Number(
                    process.env.PORT ?? 4302,
                ),

            host:
                process.env.HOST ??
                '127.0.0.1',

            nodeEnv:
                process.env.NODE_ENV ??
                'development',

            workspacePath:
                process.cwd(),

            allowedOrigins:
                process.env.JUSTAI_ALLOWED_ORIGINS
                    ? process.env.JUSTAI_ALLOWED_ORIGINS
                        .split(',')
                        .map(origin => origin.trim())
                        .filter(Boolean)
                    : DEFAULT_ALLOWED_ORIGINS,

        };

    }

    public get(): AppConfig {

        return this.config;

    }

}
