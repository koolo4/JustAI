import { MockProvider, type MockScript } from "../../src/modules/agent/providers/MockProvider.js";
import type { ModelProvider } from "../../src/modules/agent/providers/ModelProvider.js";
import { ProviderRegistry } from "../../src/modules/agent/providers/ProviderRegistry.js";

/**
 * Реестр провайдеров, где заданные id — скриптовые mock-модели (без сети).
 */
export class ScriptedRegistry extends ProviderRegistry {

    public readonly created: MockProvider[] = [];

    constructor(private readonly scripts: Record<string, MockScript>) {
        super({});
    }

    public override create(id: string, model?: string): ModelProvider {
        const script = this.scripts[id];

        if (!script) {
            return super.create(id, model);
        }

        const mock = new MockProvider(script);
        this.created.push(mock);

        return Object.assign(mock, { id, model: model ?? `${id}-model` }) as ModelProvider;
    }
}
