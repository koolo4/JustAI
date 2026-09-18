import type { AIContext } from "./AIContext.js";

export class ContextBuilder {

    private readonly context: AIContext = {};

    public workspace(
        value: string,
    ): ContextBuilder {

        this.context.workspace = value;

        return this;

    }

    public openedFiles(
        value: string[],
    ): ContextBuilder {

        this.context.openedFiles = value;

        return this;

    }

    public activeFile(
        value: string,
    ): ContextBuilder {

        this.context.activeFile = value;

        return this;

    }

    public selection(
        value: string,
    ): ContextBuilder {

        this.context.selection = value;

        return this;

    }

    public build(): AIContext {

        return {

            ...this.context,

        };

    }

}