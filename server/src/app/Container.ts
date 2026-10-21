import path from "node:path";

import { LocalFileSystem } from "../infrastructure/filesystem/LocalFileSystem.js";
import { PathResolver } from "../infrastructure/filesystem/PathResolver.js";
import { IgnoreService } from "../infrastructure/filesystem/IgnoreService.js";
import { DirectoryScanner } from "../infrastructure/filesystem/DirectoryScanner.js";

import { WorkspaceService } from "../modules/workspace/WorkspaceService.js";
import { WorkspaceController } from "../modules/workspace/WorkspaceController.js";

import { ConfigService } from "../core/config/index.js";
import { ConsoleLogger, ILogger } from "../core/logger/index.js";
import { EventBus } from "../core/events/index.js";
import { AccessGuard } from "../core/security/AccessGuard.js";

import {
    WebSocketConnectionManager,
    WebSocketGateway,
} from "../modules/websocket/index.js";

import { AgentController } from "../modules/agent/AgentController.js";
import { AgentProfiles } from "../modules/agent/profiles.js";
import { ProviderRegistry } from "../modules/agent/providers/ProviderRegistry.js";
import { budgetFromEnv } from "../modules/agent/runtime/Budget.js";
import { SessionManager } from "../modules/agent/runtime/SessionManager.js";
import { SessionStore } from "../modules/agent/runtime/SessionStore.js";
import { AgentFileSystem } from "../modules/agent/tools/AgentFileSystem.js";
import { createFileTools } from "../modules/agent/tools/fileTools.js";
import { createSearchTools } from "../modules/agent/tools/searchTools.js";
import { createShellTools } from "../modules/agent/tools/shellTools.js";
import { ProcessManager } from "../infrastructure/process/ProcessManager.js";

import type { AgentEvent } from "@justai/shared";
import { ToolRegistry } from "../modules/agent/tools/ToolRegistry.js";

import {
    IntegrationsController,
    MicrosoftOAuthService,
    MicrosoftTokenStore,
    MicrosoftGraphService,
} from "../modules/integrations/index.js";
import { createWordTools } from "../modules/integrations/microsoft/wordTools.js";

export class Container {

    private readonly workspaceRoot: string;

    public readonly eventBus: EventBus;
    public readonly accessGuard: AccessGuard;

    public readonly fileSystem: LocalFileSystem;
    public readonly pathResolver: PathResolver;
    public readonly ignoreService: IgnoreService;
    public readonly directoryScanner: DirectoryScanner;

    public readonly workspaceService: WorkspaceService;
    public readonly workspaceController: WorkspaceController;

    public readonly webSocketConnectionManager:
        WebSocketConnectionManager;

    public readonly webSocketGateway:
        WebSocketGateway;

    public readonly processManager: ProcessManager;
    public readonly toolRegistry: ToolRegistry;
    public readonly providerRegistry: ProviderRegistry;
    public readonly agentProfiles: AgentProfiles;
    public readonly sessionManager: SessionManager;
    public readonly agentController: AgentController;

    public readonly microsoftOAuth: MicrosoftOAuthService;
    public readonly microsoftGraph: MicrosoftGraphService;
    public readonly integrationsController:
        IntegrationsController;

    private readonly configService: ConfigService;
    private readonly logger: ILogger;

    constructor() {

        this.workspaceRoot =
            resolveWorkspaceRoot();

        this.configService =
            new ConfigService();

        this.logger =
            new ConsoleLogger();

        const config =
            this.configService.get();

        this.accessGuard =
            new AccessGuard({
                token:
                    process.env.JUSTAI_TOKEN ||
                    AccessGuard.generateToken(),
                allowedOrigins:
                    config.allowedOrigins,
                allowedHosts:
                    ["localhost", "127.0.0.1", "[::1]"].map(
                        host => `${host}:${config.port}`,
                    ),
                publicPaths: [
                    "/",
                    "/api/health",
                    "/api/auth/token",
                    // OAuth: браузерная навигация без заголовков; callback защищён state
                    "/api/integrations/microsoft/connect",
                    "/api/integrations/microsoft/callback",
                ],
            });

        this.eventBus =
            new EventBus();

        this.fileSystem =
            new LocalFileSystem();

        this.pathResolver =
            new PathResolver(
                this.workspaceRoot,
            );

        this.ignoreService =
            new IgnoreService(
                this.workspaceRoot,
            );

        this.directoryScanner =
            new DirectoryScanner(
                this.fileSystem,
                this.pathResolver,
                this.ignoreService,
            );

        this.workspaceService =
            new WorkspaceService(
                this.fileSystem,
                this.pathResolver,
                this.directoryScanner,
                this.eventBus,
            );

        this.workspaceController =
            new WorkspaceController(
                this.workspaceService,
            );

        this.webSocketConnectionManager =
            new WebSocketConnectionManager();

        this.webSocketGateway =
            new WebSocketGateway(
                this.eventBus,
                this.webSocketConnectionManager,
            );

        const tokenStore =
            new MicrosoftTokenStore(
                this.workspaceRoot,
            );

        this.microsoftOAuth =
            new MicrosoftOAuthService(
                {
                    clientId:
                        process.env.MICROSOFT_CLIENT_ID ?? "",
                    clientSecret:
                        process.env.MICROSOFT_CLIENT_SECRET ?? "",
                    tenant:
                        process.env.MICROSOFT_TENANT ?? "common",
                    redirectUri:
                        process.env.MICROSOFT_REDIRECT_URI ??
                        "http://localhost:4302/api/integrations/microsoft/callback",
                },
                tokenStore,
            );

        this.microsoftGraph =
            new MicrosoftGraphService(
                this.microsoftOAuth,
            );

        this.integrationsController =
            new IntegrationsController(
                this.microsoftOAuth,
            );

        const shouldIgnore =
            (name: string) =>
                this.ignoreService.shouldIgnore(name);

        const broadcast =
            (event: AgentEvent) =>
                this.webSocketConnectionManager.broadcast(event);

        const agentFiles =
            new AgentFileSystem(
                this.workspaceRoot,
                this.eventBus,
                broadcast,
            );

        this.processManager =
            new ProcessManager();

        this.toolRegistry =
            new ToolRegistry();

        for (const tool of [
            ...createFileTools(agentFiles, shouldIgnore),
            ...createSearchTools(agentFiles),
            ...createShellTools(agentFiles, this.processManager),
            ...createWordTools(this.microsoftGraph),
        ]) {
            this.toolRegistry.register(tool);
        }

        this.providerRegistry =
            new ProviderRegistry();

        this.agentProfiles =
            new AgentProfiles();

        this.sessionManager =
            new SessionManager({
                store: new SessionStore(
                    path.join(this.workspaceRoot, ".justai", "sessions"),
                ),
                providers: this.providerRegistry,
                tools: this.toolRegistry,
                profiles: this.agentProfiles,
                workspaceRoot: this.workspaceRoot,
                shouldIgnore,
                limits: budgetFromEnv(),
                emit: broadcast,
            });

        this.agentController =
            new AgentController(
                this.sessionManager,
                this.providerRegistry,
                this.agentProfiles,
            );
    }

    public getConfigService(): ConfigService {
        return this.configService;
    }

    public getLogger(): ILogger {
        return this.logger;
    }

    public getWorkspaceRoot(): string {
        return this.workspaceRoot;
    }

    public async initialize(): Promise<void> {
        await this.ignoreService.initialize();
    }

    public getAvailableTools(): string[] {
        return this.toolRegistry
            .list()
            .map(tool => tool.name);
    }
}

/**
 * JUSTAI_WORKSPACE задаёт папку проекта явно; иначе — корень репозитория JustAI
 * (родитель папки server, если сервер запущен из неё).
 */
function resolveWorkspaceRoot(): string {
    if (process.env.JUSTAI_WORKSPACE) {
        return path.resolve(process.env.JUSTAI_WORKSPACE);
    }

    const currentDirectory =
        process.cwd();

    return path.basename(currentDirectory).toLowerCase() === "server"
        ? path.resolve(currentDirectory, "..")
        : currentDirectory;
}
