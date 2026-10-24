import { describe, expect, it } from "vitest";

import { describeStep, parseScenario, scenarioBlock, ScenarioError } from "../../../../src/modules/github/e2e/scenario.js";

describe("e2e scenarios", () => {
    it("parses YAML steps with one action each", () => {
        const scenario = parseScenario([
            "name: Меню",
            "url: http://localhost:8080/",
            "steps:",
            "  - screenshot: { name: menu, width: 1280 }",
            "  - click: '.mode-card[data-mode=\"hero\"]'",
            "  - expectText: { selector: '#kicker', contains: 'Раунд 1' }",
            "  - expectNoConsoleErrors:",
            "  - run: { command: node tests/smoke.js, expectOutput: PASS }",
        ].join("\n"));

        expect(scenario).toMatchObject({ name: "Меню", url: "http://localhost:8080/", stopOnFailure: true });
        expect(scenario.steps.map(step => step.kind)).toEqual(["screenshot", "click", "expectText", "expectNoConsoleErrors", "run"]);
        expect(describeStep(scenario.steps[2]!)).toBe("expectText `#kicker` → \"Раунд 1\"");
    });

    it("describes a desktop window step", () => {
        const [step] = parseScenario("steps:\n  - window: { command: dist/app.exe, title: 'Калькулятор', name: main, waitSec: 10 }").steps;
        expect(step).toEqual({ kind: "window", value: { command: "dist/app.exe", title: "Калькулятор", name: "main", waitSec: 10 } });
        expect(() => parseScenario("steps:\n  - window: { command: app.exe }")).toThrow(/title/);
    });

    it("accepts JSON too", () => {
        expect(parseScenario('{"steps":[{"press":"Escape"},{"wait":200}]}').steps).toEqual([
            { kind: "press", value: "Escape" },
            { kind: "wait", value: 200 },
        ]);
    });

    it("explains mistakes with the step number", () => {
        expect(() => parseScenario("steps:\n  - clik: '#a'")).toThrow(/Step 1: unknown action "clik"/);
        expect(() => parseScenario("steps:\n  - click: '#a'\n    wait: 10")).toThrow(/exactly one action/);
        expect(() => parseScenario("steps:\n  - expectText: { contains: x }")).toThrow(/Step 1 \(expectText\)/);
        expect(() => parseScenario("url: x")).toThrow(ScenarioError);
    });

    it("finds the scenario block in an issue body", () => {
        const body = "Проверь меню\n/justai e2e #5\n```yaml\nsteps:\n  - click: '#a'\n```\n";
        expect(scenarioBlock(body)).toBe("steps:\n  - click: '#a'\n");
        expect(scenarioBlock("```js\nconsole.log(1)\n```")).toBeNull();
    });
});
