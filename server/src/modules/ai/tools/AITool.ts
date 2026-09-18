export interface ToolResult {

    success: boolean;

    content: string;

}

export interface AITool {

    readonly name: string;

    readonly description: string;

    readonly parameters?: Record<string, unknown>;

    execute(

        args: Record<string, string>,

    ): Promise<ToolResult>;

}
