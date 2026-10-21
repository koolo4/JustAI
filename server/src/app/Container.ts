import path from "node:path";

import { LocalFileSystem } from "../infrastructure/filesystem/LocalFileSystem.js";
import { PathResolver } from "../infrastructure/filesystem/PathResolver.js";
import { IgnoreService } from "../infrastructure/filesystem/IgnoreService.js";
import { DirectoryScanner } from "../infrastructure/filesystem/DirectoryScanner.js";

import { WorkspaceService } from "../modules/workspace/WorkspaceService.js";
import { WorkspaceController } from "../modules/workspace/WorkspaceController.js";

import { ConfigService } from "../core/config/index.js";
import { ConsoleLogger, ILogger } from "../core/logger/index.js";
import {
    EventBus,
    FileCreatedEvent,
    FileDeletedEvent,
    FileSavedEvent,
} from "../core/events/index.js";
import { GitService } from "../infrastructure/git/GitService.js";
import { SnapshotService } from "../infrastructure/git/SnapshotService.js";
import { createGitTools } from "../modules/agent/tools/gitTools.js";
import { createTodoTool } from "../modules/agent/tools/todoTool.js";
import { createWebTools } from "../modules/agent/tools/webTools.js";
import { createDelegateTool } from "../modules/agent/tools/delegateTool.js";
import { ExecutorRunner } from "../modules/agent/runtime/ExecutorRunner.js";
import { Verifier, verifyKindsFromEnv } from "../modules/agent/runtime/Verifier.js";
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
import { PermissionService } from "../modules/agent/permissions/PermissionService.js";

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
    public readonly gitService: GitService;
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

        this.gitService =
            new GitService();

        const snapshots =
            new SnapshotService(
                this.gitService,
                this.workspaceRoot,
            );

        this.toolRegistry =
            new ToolRegistry();

        for (const tool of [
            ...createFileTools(agentFiles, shouldIgnore),
            ...createSearchTools(agentFiles),
            ...createShellTools(agentFiles, this.processManager),
            ...createGitTools(this.gitService, this.workspaceRoot),
            createTodoTool(),
            ...createWebTools(),
            ...createWordTools(this.microsoftGraph),
            // SessionManager создаётся ниже — связываем лениво.
            createDelegateTool(() => (input, context) => this.sessionManager.delegate(input, context)),
        ]) {
            this.toolRegistry.register(tool);
        }

        this.providerRegistry =
            new ProviderRegistry();

        this.agentProfiles =
            new AgentProfiles();

        const permissions =
            new PermissionService({
                rulesFile: path.join(this.workspaceRoot, ".justai", "permissions.json"),
                emit: broadcast,
            });

        const executorRunner =
            new ExecutorRunner({
                providers: this.providerRegistry,
                tools: this.toolRegistry,
                profiles: this.agentProfiles,
                permissions,
                snapshots,
                workspaceRoot: this.workspaceRoot,
                shouldIgnore,
                limits: {
                    ...budgetFromEnv(),
                    maxSteps: Number(process.env.JUSTAI_EXECUTOR_MAX_STEPS) || 40,
                },
            });

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
                permissions,
                verifier: new Verifier({
                    processes: this.processManager,
                    workspaceRoot: this.workspaceRoot,
                    kinds: verifyKindsFromEnv(process.env.JUSTAI_VERIFY),
                    timeoutMs: Number(process.env.JUSTAI_VERIFY_TIMEOUT_MS) || 300_000,
                }),
                executor: {
                    defaultProvider: process.env.JUSTAI_EXECUTOR_PROVIDER || "ollama",
                    runner: executorRunner,
                },
                snapshots,
                onReverted: async changes => {
                    for (const change of changes) {
                        await this.eventBus.publish(
                            change.status === "modified"
                                ? new FileSavedEvent(change.path)
                                : change.status === "added"
                                    ? new FileDeletedEvent(change.path)
                                    : new FileCreatedEvent(change.path),
                        );
                    }
                },
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
