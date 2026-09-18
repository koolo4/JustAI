import type {
    AIProvider,
    AIProviderRequest,
    AIProviderResponse,
} from "../contracts/AIProvider.js";

export class MockProvider implements AIProvider {

    public readonly name = "mock";

    public async ask(
        request: AIProviderRequest,
    ): Promise<AIProviderResponse> {
        const prompt = request.prompt;

        if (prompt.includes("===== TOOL RESULT =====")) {
            const toolResult =
                this.extractToolResult(prompt);

            return {
                content:
                    this.buildFinalAnswer(
                        toolResult,
                        prompt,
                    ),
            };
        }

        const userPrompt =
            this.extractUserPrompt(prompt);

        const lower =
            userPrompt.toLowerCase();

        if (
            this.canUseTool(request, "word_edit") &&
            lower.includes("word") &&
            (
                lower.includes("замени") ||
                lower.includes("измени") ||
                lower.includes("отредакт") ||
                lower.includes("replace")
            )
        ) {
            const parsed =
                this.extractWordEdit(userPrompt);

            if (parsed) {
                return {
                    content: "",
                    toolCall: {
                        tool: "word_edit",
                        arguments: parsed,
                    },
                };
            }
        }

        if (
            this.canUseTool(request, "edit_file") &&
            (
                lower.includes("замени") ||
                lower.includes("replace") ||
                lower.includes("измени файл") ||
                lower.includes("edit file")
            )
        ) {
            const parsed =
                this.extractLocalEdit(userPrompt);

            if (parsed) {
                return {
                    content: "",
                    toolCall: {
                        tool: "edit_file",
                        arguments: parsed,
                    },
                };
            }
        }

        if (
            this.canUseTool(request, "list_files") &&
            (
                lower.includes("покажи файлы") ||
                lower.includes("список файлов") ||
                lower.includes("list files") ||
                lower.includes("какие файлы")
            )
        ) {
            return {
                content: "",
                toolCall: {
                    tool: "list_files",
                    arguments: {
                        path: this.extractDirectory(
                            userPrompt,
                        ),
                    },
                },
            };
        }

        if (
            (
                this.canUseTool(request, "read_file") ||
                this.canUseTool(request, "word_read")
            ) &&
            (
                lower.includes("прочитай") ||
                lower.includes("прочитать") ||
                lower.includes("открой") ||
                lower.includes("открыть") ||
                lower.includes("read") ||
                lower.includes("open")
            )
        ) {
            const filePath =
                this.extractFilePath(
                    userPrompt,
                );

            if (!filePath) {
                return {
                    content:
                        "Укажи путь к файлу, который нужно прочитать.",
                };
            }

            const isWord =
                filePath.toLowerCase().endsWith(".docx");

            const tool =
                isWord &&
                this.canUseTool(request, "word_read")
                    ? "word_read"
                    : this.canUseTool(request, "read_file")
                        ? "read_file"
                        : "";

            if (!tool) {
                return {
                    content:
                        "The selected agent does not have a tool for this file.",
                };
            }

            return {
                content: "",
                toolCall: {
                    tool,
                    arguments: {
                        path: filePath,
                    },
                },
            };
        }

        return {
            content:
                `Mock AI response: ${userPrompt}`,
        };
    }

    private canUseTool(
        request: AIProviderRequest,
        name: string,
    ): boolean {
        return Boolean(
            request.tools?.some(
                tool => tool.name === name,
            ),
        );
    }

    private extractUserPrompt(
        prompt: string,
    ): string {
        const markers = [
            "===== ACTIVE FILE =====",
            "----- IDE Context -----",
        ];

        let result = prompt;

        for (const marker of markers) {
            const index = result.indexOf(marker);

            if (index !== -1) {
                result = result.slice(0, index);
                break;
            }
        }

        return result.trim();
    }

    private extractFilePath(
        prompt: string,
    ): string {
        const match =
            prompt.match(
                /(?:прочитай|прочитать|открой|открыть|read|open)\s+(?:файл\s+|the\s+)?(?:"([^"]+)"|'([^']+)'|`([^`]+)`|([^\s]+))/i,
            );

        if (!match) {
            return "";
        }

        return (
            match[1] ??
            match[2] ??
            match[3] ??
            match[4] ??
            ""
        ).trim();
    }

    private extractDirectory(
        prompt: string,
    ): string {
        const match =
            prompt.match(
                /(?:в папке|директории|directory|folder)\s+([^\s,]+)/i,
            );

        return match?.[1] ?? ".";
    }

    private extractLocalEdit(
        prompt: string,
    ): Record<string, string> | null {
        const pathMatch =
            prompt.match(
                /(?:файл|file)\s+(?:"([^"]+)"|'([^']+)'|`([^`]+)`|([^\s:,]+))/i,
            );

        const replaceMatch =
            prompt.match(
                /(?:замени|replace)\s+(?:"([^"]+)"|'([^']+)'|`([^`]+)`|(.+?))\s+(?:на|with|to)\s+(?:"([^"]+)"|'([^']+)'|`([^`]+)`|(.+))$/i,
            );

        if (!pathMatch || !replaceMatch) {
            return null;
        }

        return {
            path:
                pathMatch[1] ??
                pathMatch[2] ??
                pathMatch[3] ??
                pathMatch[4] ??
                "",
            find:
                replaceMatch[1] ??
                replaceMatch[2] ??
                replaceMatch[3] ??
                replaceMatch[4] ??
                "",
            replace:
                replaceMatch[5] ??
                replaceMatch[6] ??
                replaceMatch[7] ??
                replaceMatch[8] ??
                "",
        };
    }

    private extractWordEdit(
        prompt: string,
    ): Record<string, string> | null {
        const match =
            prompt.match(
                /(?:замени|replace)\s+(?:"([^"]+)"|'([^']+)'|`([^`]+)`)\s+(?:на|with|to)\s+(?:"([^"]+)"|'([^']+)'|`([^`]+)`)/i,
            );

        const pathMatch =
            prompt.match(
                /(?:word|документ|файл)\s+(?:"([^"]+)"|'([^']+)'|`([^`]+)`|([^\s]+\.docx))/i,
            );

        if (!match || !pathMatch) {
            return null;
        }

        const find =
            match[1] ?? match[2] ?? match[3] ?? "";
        const replace =
            match[4] ?? match[5] ?? match[6] ?? "";
        const path =
            pathMatch[1] ??
            pathMatch[2] ??
            pathMatch[3] ??
            pathMatch[4] ??
            "";

        return {
            path,
            find,
            replace,
            share: "true",
        };
    }

    private extractToolResult(
        prompt: string,
    ): string {
        const marker = "===== TOOL RESULT =====";
        const start = prompt.indexOf(marker);

        if (start === -1) {
            return "";
        }

        const contentStart =
            start + marker.length;

        const instructionMarker =
            "===== INSTRUCTION =====";

        const end =
            prompt.indexOf(
                instructionMarker,
                contentStart,
            );

        return (
            end === -1
                ? prompt.slice(contentStart)
                : prompt.slice(contentStart, end)
        ).trim();
    }

    private buildFinalAnswer(
        toolResult: string,
        prompt: string,
    ): string {
        if (!toolResult) {
            return "Инструмент не вернул результат.";
        }

        if (
            prompt.toLowerCase().includes("word") ||
            prompt.toLowerCase().includes("документ")
        ) {
            return toolResult;
        }

        const normalized =
            toolResult.trim();

        if (
            normalized.startsWith("# JustAI")
        ) {
            return [
                "Это проект JustAI.",
                "",
                "Это AI IDE, написанная на TypeScript.",
                "",
                "Для запуска требуется:",
                "- Node.js 22+",
                "- npm 11+",
            ].join("\n");
        }

        return [
            "Результат инструмента:",
            "",
            normalized,
        ].join("\n");
    }
}
