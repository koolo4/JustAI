import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";

/**
 * Monaco из локального пакета (без CDN): IDE должна работать офлайн.
 */
self.MonacoEnvironment = {
    getWorker(_workerId: string, label: string) {
        switch (label) {
            case "json":
                return new JsonWorker();
            case "css":
            case "scss":
            case "less":
                return new CssWorker();
            case "html":
            case "handlebars":
            case "razor":
                return new HtmlWorker();
            case "typescript":
            case "javascript":
                return new TsWorker();
            default:
                return new EditorWorker();
        }
    },
};

loader.config({ monaco });

// Для e2e-проверок в режиме разработки: доступ к моделям редактора из консоли.
if (import.meta.env.DEV) {
    (window as unknown as { __monaco?: typeof monaco }).__monaco = monaco;
}

const LANGUAGES: Record<string, string> = {
    ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    json: "json", jsonc: "json",
    css: "css", scss: "scss", less: "less",
    html: "html", htm: "html", vue: "html",
    md: "markdown", markdown: "markdown",
    py: "python", rs: "rust", go: "go", java: "java", kt: "kotlin", cs: "csharp",
    c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp",
    php: "php", rb: "ruby", swift: "swift", sql: "sql",
    sh: "shell", bash: "shell", ps1: "powershell", psm1: "powershell",
    yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", env: "ini",
    xml: "xml", svg: "xml", dockerfile: "dockerfile",
};

export function languageFor(path: string): string {
    const name = path.split("/").pop()?.toLowerCase() ?? "";

    if (name === "dockerfile") {
        return "dockerfile";
    }

    const extension = name.includes(".") ? name.split(".").pop()! : "";
    return LANGUAGES[extension] ?? "plaintext";
}
