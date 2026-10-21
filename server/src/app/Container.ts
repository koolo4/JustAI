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

import {
    WebSocketConnectionManager,
    WebSocketGateway,
} from "../modules/websocket/index.js";

import {
    AIController,
    AIService,
} from "../modules/ai/index.js";

import { ContextService } from "../modules/ai/context/ContextService.js";
import { ProviderFactory } from "../modules/ai/providers/ProviderFactory.js";
import { PromptBuilder } from "../modules/ai/prompt/PromptBuilder.js";
import { AgentProfileService } from "../modules/ai/agents/AgentProfileService.js";
import { Agent } from "../modules/ai/agent/Agent.js";
import { Planner } from "../modules/ai/agent/Planner.js";
import { ToolRegistry } from "../modules/ai/tools/ToolRegistry.js";
import { ToolExecutor } from "../modules/ai/tools/ToolExecutor.js";
import { ReadFileTool } from "../modules/ai/tools/ReadFileTool.js";
import { ListFilesTool } from "../modules/ai/tools/ListFilesTool.js";
import { EditFileTool } from "../modules/ai/tools/EditFileTool.js";

import {
    IntegrationsController,
    MicrosoftOAuthService,
    MicrosoftTokenStore,
    MicrosoftGraphService,
    WordEditTool,
    WordReadTool,
} from "../modules/integrations/index.js";

export class Container {

    private readonly workspaceRoot: string;

    public readonly eventBus: EventBus;

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

    public readonly contextService: ContextService;
    public readonly promptBuilder: PromptBuilder;
    public readonly toolRegistry: ToolRegistry;

    public readonly readFileTool: ReadFileTool;
    public readonly listFilesTool: ListFilesTool;
    public readonly editFileTool: EditFileTool;

    public readonly toolExecutor: ToolExecutor;
    public readonly planner: Planner;
    public readonly agent: Agent;

    public readonly providerFactory: ProviderFactory;
    public readonly agentProfiles: AgentProfileService;
    public readonly aiService: AIService;
    public readonly aiController: AIController;

    public readonly microsoftOAuth: MicrosoftOAuthService;
    public readonly microsoftGraph: MicrosoftGraphService;
    public readonly integrationsController:
        IntegrationsController;

    public readonly wordEditTool: WordEditTool;
    public readonly wordReadTool: WordReadTool;

    private readonly configService: ConfigService;
    private readonly logger: ILogger;

    constructor() {

        const currentDirectory =
            process.cwd();

        this.workspaceRoot =
            path.basename(
                currentDirectory,
            ).toLowerCase() === "server"
                ? path.resolve(
                    currentDirectory,
                    "..",
                )
                : currentDirectory;

        this.configService =
            new ConfigService();

        this.logger =
            new ConsoleLogger();

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

        this.contextService =
            new ContextService();

        this.promptBuilder =
            new PromptBuilder();

        this.providerFactory =
            new ProviderFactory();

        this.agentProfiles =
            new AgentProfileService();

        const defaultProvider =
            this.providerFactory.create(
                process.env.JUSTAI_PROVIDER ?? "mock",
            );

        this.toolRegistry =
            new ToolRegistry();

        this.readFileTool =
            new ReadFileTool(
                this.workspaceRoot,
            );

        this.listFilesTool =
            new ListFilesTool(
                this.workspaceRoot,
            );

        this.editFileTool =
            new EditFileTool(
                this.workspaceRoot,
            );

        this.toolRegistry.register(
            this.readFileTool,
        );

        this.toolRegistry.register(
            this.listFilesTool,
        );

        this.toolRegistry.register(
            this.editFileTool,
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

        this.wordEditTool =
            new WordEditTool(
                this.microsoftGraph,
            );

        this.wordReadTool =
            new WordReadTool(
                this.microsoftGraph,
            );

        this.toolRegistry.register(
            this.wordEditTool,
        );

        this.toolRegistry.register(
            this.wordReadTool,
        );

        this.toolExecutor =
            new ToolExecutor(
                this.toolRegistry,
            );

        this.planner =
            new Planner();

        this.agent =
            new Agent(
                this.planner,
                this.toolExecutor,
            );

        this.aiService =
            new AIService(
                defaultProvider,
                this.providerFactory,
                this.contextService,
                this.toolRegistry,
                this.promptBuilder,
                this.agent,
                this.agentProfiles,
            );

        this.aiController =
            new AIController(
                this.aiService,
                this.providerFactory,
                this.agentProfiles,
            );

        this.integrationsController =
            new IntegrationsController(
                this.microsoftOAuth,
            );
    }

    public getConfigService(): ConfigService {
        return this.configService;
    }

    public getLogger(): ILogger {
        return this.logger;
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
