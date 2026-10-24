import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BrowserService } from "../../../../src/infrastructure/browser/BrowserService.js";
import { ProcessManager } from "../../../../src/infrastructure/process/ProcessManager.js";
import { e2eReport, runScenario } from "../../../../src/modules/github/e2e/E2ERunner.js";
import { parseScenario } from "../../../../src/modules/github/e2e/scenario.js";
import { StaticServer } from "../../../../src/modules/github/e2e/StaticServer.js";
import { createTempWorkspace, type TempWorkspace } from "../../../helpers/tempWorkspace.js";

const PAGE = `<!doctype html>
<html><head><title>Quiz</title><link rel="stylesheet" href="style.css"></head>
<body>
  <section id="menu"><button class="card" data-mode="hero">Угадай героя</button></section>
  <section id="game" hidden><div id="kicker">Раунд 1 из 10</div>
    <button class="answer">A</button><button class="answer">B</button></section>
  <script>
    document.querySelector('.card').addEventListener('click', () => {
      document.getElementById('menu').hidden = true;
      document.getElementById('game').hidden = false;
    });
    document.querySelectorAll('.answer').forEach(b => b.addEventListener('click', () => b.classList.add('is-correct')));
    window.addEventListener('keydown', e => { if (e.key === 'Escape') { document.getElementById('menu').hidden = false; document.getElementById('game').hidden = true; } });
  </script>
</body></html>`;

describe("e2e runner", () => {
    let workspace: TempWorkspace;
    let server: StaticServer;
    let base: string;
    const browser = new BrowserService();
    let available = true;

    beforeAll(async () => {
        workspace = await createTempWorkspace();
        await workspace.write("index.html", PAGE);
        // Заглавные через CSS: проверка текста должна смотреть на текст страницы («Раунд 1»), а не на «РАУНД 1».
        await workspace.write("style.css", "body { background: #111; color: #eee; } #kicker { text-transform: uppercase; }");
        await workspace.write("ok.js", "console.log('SMOKE: PASS')");
        server = new StaticServer(workspace.root);
        base = await server.start();

        try {
            await browser.page("probe");
            await browser.close("probe");
        }
        catch {
            available = false;
        }
    }, 180_000);

    afterAll(async () => {
        await browser.closeAll();
        await server.stop();
        await workspace.dispose();
    });

    it("runs steps mechanically and reports PASS with screenshots and metrics", async (test) => {
        if (!available) test.skip();

        const scenario = parseScenario([
            "name: game",
            "steps:",
            "  - screenshot: { name: menu, width: 1280 }",
            "  - click: '.card[data-mode=\"hero\"]'",
            "  - expectVisible: '#game'",
            "  - expectText: { selector: '#kicker', contains: 'Раунд 1' }",
            "  - click: '.answer'",
            "  - expectClass: { selector: '.answer', any: [is-correct, is-wrong] }",
            "  - expectCount: { selector: '.answer', equals: 2 }",
            "  - eval: { code: \"document.title\", expect: Quiz }",
            "  - press: Escape",
            "  - expectHidden: '#game'",
            "  - screenshot: { name: menu-mobile, width: 375 }",
            "  - run: { command: node ok.js, expectOutput: 'SMOKE: PASS' }",
            "  - expectNoConsoleErrors:",
        ].join("\n"));

        const result = await runScenario(scenario, { browser, baseUrl: base, pageKey: "e2e-test", processes: new ProcessManager(), cwd: workspace.root });

        expect(result.steps.filter(step => !step.ok)).toEqual([]);
        expect(result.passed).toBe(true);
        expect(result.screenshots.map(shot => [shot.name, shot.width])).toEqual([["menu", 1280], ["menu-mobile", 375]]);
        expect(result.metrics?.requests).toBeGreaterThanOrEqual(2);

        const report = e2eReport(result, "ветка `main`", ["![menu](x)"]);
        expect(report).toContain("✅ PASS");
        expect(report).toContain("без модели");
        expect(report).toContain("| 4 | expectText `#kicker` → \"Раунд 1\" | ✓ \"Раунд 1 из 10\"");
    }, 120_000);

    it("stops at the first failing step with the actual value, a screenshot and the page HTML", async (test) => {
        if (!available) test.skip();

        const scenario = parseScenario([
            "steps:",
            "  - click: '.card'",
            "  - expectText: { selector: '#kicker', contains: 'Раунд 2' }",
            "  - click: '.answer'",
        ].join("\n"));

        const result = await runScenario(scenario, { browser, baseUrl: base, pageKey: "e2e-fail" });

        expect(result.passed).toBe(false);
        expect(result.steps).toHaveLength(3);
        expect(result.steps[2]!.error).toContain("Раунд 1 из 10");
        expect(result.failure?.screenshot).toBeTruthy();
        expect(result.failure?.html).toContain("kicker");
        expect(e2eReport(result, "main", [])).toContain("Падение на шаге 2");
    }, 120_000);

    it("compares screenshots with the previous run", async (test) => {
        if (!available) test.skip();

        const scenario = parseScenario("steps:\n  - screenshot: menu");
        const first = await runScenario(scenario, { browser, baseUrl: base, pageKey: "e2e-diff" });
        const same = await runScenario(scenario, { browser, baseUrl: base, pageKey: "e2e-diff", previous: async () => first.screenshots[0]!.dataBase64 });

        expect(same.screenshots[0]!.diff).toBeLessThan(0.01);

        await workspace.write("style.css", "body { background: #c00; color: #eee; }");
        const changed = await runScenario(scenario, { browser, baseUrl: base, pageKey: "e2e-diff", previous: async () => first.screenshots[0]!.dataBase64 });

        expect(changed.screenshots[0]!.diff).toBeGreaterThan(0.5);
        expect(e2eReport(changed, "main", [])).toContain("Изменения внешнего вида");
    }, 120_000);
});
