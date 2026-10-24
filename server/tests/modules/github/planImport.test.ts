import { describe, expect, it } from "vitest";

import { isPlan, parsePlan, resolveRefs } from "../../../src/modules/github/planImport.js";

const PLAN = `Вот план:

### ISSUE
[justai] Каркас сайта
Цель: index.html и css/style.css.

### ISSUE
Заголовок: Страница игры
Требования: js/game.js.
Depends on @1

### ISSUE
/justai e2e @2
\`\`\`yaml
steps:
  - click: '#start'
\`\`\`
`;

describe("plan import", () => {
    it("splits a planner's text into tasks and command issues", () => {
        expect(isPlan(PLAN)).toBe(true);
        expect(isPlan("просто текст")).toBe(false);

        const blocks = parsePlan(PLAN, "justai");

        expect(blocks.map(block => [block.title, block.command])).toEqual([
            ["[justai] Каркас сайта", false],
            ["[justai] Страница игры", false],
            ["Команда: /justai e2e @2", true],
        ]);
        expect(blocks[1]!.body).toBe("Требования: js/game.js.\nDepends on @1");
        expect(blocks[2]!.body).toContain("steps:");
    });

    it("turns @N into real issue numbers only in dependency and command lines", () => {
        expect(resolveRefs("Пиши на a@1.ru\nDepends on @1, @2", [41, 42], "justai")).toBe("Пиши на a@1.ru\nDepends on #41, #42");
        expect(resolveRefs("/justai e2e @2\n```yaml```", [41, 42], "justai")).toBe("/justai e2e #42\n```yaml```");
        expect(resolveRefs("Depends on @5", [41], "justai")).toBe("Depends on @5");
    });
});
