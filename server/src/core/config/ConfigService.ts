import { AppConfig } from './AppConfig.js';

export class ConfigService {

    private readonly config: AppConfig;

    constructor() {

        this.config = {

            port:
                Number(
                    process.env.PORT ?? 4302,
                ),

            nodeEnv:
                process.env.NODE_ENV ??
                'development',

            workspacePath:
                process.cwd(),

        };

    }

    public get(): AppConfig {

        return this.config;

    }

}