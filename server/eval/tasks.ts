import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Задача-эталон: исходные файлы, просьба к агенту и независимая проверка результата.
 * `solution` — эталонное решение: тесты проверяют, что задача решаема и проверка честная.
 */
export interface EvalTask {
    id: string;
    title: string;
    prompt: string;
    files: Record<string, string>;
    solution: Record<string, string>;
    /** Пустая строка — успех, иначе причина провала. */
    check(root: string): string;
}

const PACKAGE = JSON.stringify({ name: "eval-fixture", version: "1.0.0", scripts: { test: "node --test" } }, null, 2);

function run(root: string, args: string[]): { ok: boolean; output: string } {
    try {
        const output = execFileSync(process.execPath, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
        return { ok: true, output };
    }
    catch (error) {
        const failed = error as { stdout?: string; stderr?: string; message: string };
        return { ok: false, output: `${failed.stdout ?? ""}${failed.stderr ?? ""}` || failed.message };
    }
}

function nodeTests(root: string): string {
    const result = run(root, ["--test"]);
    return result.ok ? "" : `node --test failed: ${lastLines(result.output)}`;
}

function lastLines(text: string): string {
    return text.trim().split("\n").slice(-3).join(" | ").slice(0, 300);
}

export const EVAL_TASKS: EvalTask[] = [
    {
        id: "missing-function",
        title: "Implement a missing function so the tests pass",
        prompt: "The test for mul in math.test.js fails because mul is missing. Implement mul(a, b) in math.js and export it.",
        files: {
            "package.json": PACKAGE,
            "math.js": "function add(a, b) {\n  return a + b;\n}\n\nmodule.exports = { add };\n",
            "math.test.js": [
                "const test = require('node:test');",
                "const assert = require('node:assert');",
                "const { add, mul } = require('./math.js');",
                "test('add', () => assert.strictEqual(add(2, 3), 5));",
                "test('mul', () => assert.strictEqual(mul(4, 5), 20));",
                "",
            ].join("\n"),
        },
        solution: {
            "math.js": "function add(a, b) {\n  return a + b;\n}\n\nfunction mul(a, b) {\n  return a * b;\n}\n\nmodule.exports = { add, mul };\n",
        },
        check: nodeTests,
    },
    {
        id: "fix-bug",
        title: "Find and fix a bug reported by a failing test",
        prompt: "npm test fails. Find the bug in stats.js and fix it without changing the tests.",
        files: {
            "package.json": PACKAGE,
            "stats.js": [
                "function average(values) {",
                "  let sum = 0;",
                "  for (let i = 0; i <= values.length; i++) {",
                "    sum += values[i];",
                "  }",
                "  return sum / values.length;",
                "}",
                "",
                "module.exports = { average };",
                "",
            ].join("\n"),
            "stats.test.js": [
                "const test = require('node:test');",
                "const assert = require('node:assert');",
                "const { average } = require('./stats.js');",
                "test('average', () => assert.strictEqual(average([2, 4, 6]), 4));",
                "test('single value', () => assert.strictEqual(average([5]), 5));",
                "",
            ].join("\n"),
        },
        solution: {
            "stats.js": "function average(values) {\n  let sum = 0;\n  for (let i = 0; i < values.length; i++) {\n    sum += values[i];\n  }\n  return sum / values.length;\n}\n\nmodule.exports = { average };\n",
        },
        check: root => {
            const tests = readFileSync(path.join(root, "stats.test.js"), "utf8");
            return tests.includes("average([2, 4, 6]), 4") ? nodeTests(root) : "the tests were changed";
        },
    },
    {
        id: "create-cli",
        title: "Create a small command-line script from scratch",
        prompt: "Create greet.js: `node greet.js Ann` must print exactly `Hello, Ann!` and `node greet.js` without arguments must print `Hello, world!`. Run both commands to check.",
        files: { "package.json": PACKAGE },
        solution: { "greet.js": "const name = process.argv[2] || 'world';\nconsole.log(`Hello, ${name}!`);\n" },
        check: root => {
            if (!existsSync(path.join(root, "greet.js"))) {
                return "greet.js was not created";
            }

            const named = run(root, ["greet.js", "Ann"]);
            const plain = run(root, ["greet.js"]);

            if (named.output.trim() !== "Hello, Ann!") return `node greet.js Ann printed: ${lastLines(named.output)}`;
            if (plain.output.trim() !== "Hello, world!") return `node greet.js printed: ${lastLines(plain.output)}`;
            return "";
        },
    },
    {
        id: "write-tests",
        title: "Write tests for existing code",
        prompt: "Write tests for slugify in slugify.test.js using node:test (at least 3 test cases: spaces, upper case, punctuation). Run npm test and make sure it passes. Do not change slugify.js.",
        files: {
            "package.json": PACKAGE,
            "slugify.js": [
                "function slugify(text) {",
                "  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');",
                "}",
                "",
                "module.exports = { slugify };",
                "",
            ].join("\n"),
        },
        solution: {
            "slugify.test.js": [
                "const test = require('node:test');",
                "const assert = require('node:assert');",
                "const { slugify } = require('./slugify.js');",
                "test('spaces', () => assert.strictEqual(slugify('hello world'), 'hello-world'));",
                "test('upper case', () => assert.strictEqual(slugify('Hello'), 'hello'));",
                "test('punctuation', () => assert.strictEqual(slugify('Hi, there!'), 'hi-there'));",
                "",
            ].join("\n"),
        },
        check: root => {
            const file = path.join(root, "slugify.test.js");

            if (!existsSync(file)) return "slugify.test.js was not created";

            const source = readFileSync(path.join(root, "slugify.js"), "utf8");
            if (!source.includes("replace(/[^a-z0-9]+/g, '-')")) return "slugify.js was changed";

            const cases = (readFileSync(file, "utf8").match(/\btest\s*\(/g) ?? []).length;
            if (cases < 3) return `only ${cases} test case(s)`;

            return nodeTests(root);
        },
    },
];
