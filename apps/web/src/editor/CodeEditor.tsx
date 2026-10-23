import "./monacoSetup";

import Editor, { type OnMount } from "@monaco-editor/react";
import { useEffect, useRef, useState } from "react";

import type { DiagnosticsResponse } from "@justai/shared";

import { apiFetch, readApiError } from "../services/http";
import { languageFor } from "./monacoSetup";
import { ProblemsPanel } from "./ProblemsPanel";
import { isDirty, type EditorTab } from "./useEditorTabs";

interface Props {
    tabs: EditorTab[];
    active: string;
    onActivate(path: string): void;
    onClose(path: string): void;
    onChange(path: string, value: string): void;
    onSave(path: string): void;
    onTakeDisk(path: string): void;
    onKeepMine(path: string): void;
    /** Открыть файл (из списка ошибок). */
    onOpenFile(path: string): void;
}

export function CodeEditor(props: Props) {
    const { tabs, active } = props;
    const tab = tabs.find(item => item.path === active);

    // Обработчик Ctrl+S регистрируется один раз — берём актуальные данные через ref.
    const latest = useRef(props);
    latest.current = props;

    const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
    const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);

    const handleMount: OnMount = (editor, monaco) => {
        editorRef.current = editor;
        monacoRef.current = monaco;

        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
            const current = latest.current;

            if (current.active) {
                current.onSave(current.active);
            }
        });

        syncEol();
    };

    // Переводы строк — как в файле: иначе на Windows Monaco перепишет LF-файл в CRLF при сохранении.
    const syncEol = () => {
        const model = editorRef.current?.getModel();
        const monaco = monacoRef.current;
        const current = latest.current.tabs.find(item => item.path === latest.current.active);

        if (!model || !monaco || !current) {
            return;
        }

        const eol = current.baseline.includes("\r\n")
            ? monaco.editor.EndOfLineSequence.CRLF
            : monaco.editor.EndOfLineSequence.LF;

        if (model.getEndOfLineSequence() !== eol) {
            model.pushEOL(eol);
        }
    };

    useEffect(syncEol, [active, tab?.baseline]);

    // Ошибки компилятора и линтера: подсветка в открытых файлах и список под редактором.
    const [problems, setProblems] = useState<DiagnosticsResponse | null>(null);
    const [showProblems, setShowProblems] = useState(false);
    const [checking, setChecking] = useState(false);
    const [problemsError, setProblemsError] = useState("");
    const pendingReveal = useRef<{ path: string; line: number; column: number } | null>(null);

    async function runCheck() {
        setShowProblems(true);
        setChecking(true);
        setProblemsError("");

        try {
            const response = await apiFetch("/workspace/diagnostics");

            if (!response.ok) {
                throw new Error(await readApiError(response));
            }

            setProblems(await response.json() as DiagnosticsResponse);
        }
        catch (reason) {
            setProblemsError(reason instanceof Error ? reason.message : String(reason));
        }
        finally {
            setChecking(false);
        }
    }

    useEffect(() => {
        const monaco = monacoRef.current;

        if (!monaco) {
            return;
        }

        for (const model of monaco.editor.getModels()) {
            const modelPath = model.uri.path.replace(/^\//, "");
            const markers = (problems?.diagnostics ?? [])
                .filter(item => item.path === modelPath)
                .map(item => ({
                    startLineNumber: item.line,
                    startColumn: item.column,
                    endLineNumber: item.line,
                    endColumn: model.getLineMaxColumn(Math.min(item.line, model.getLineCount())),
                    message: item.code ? `${item.message} (${item.code})` : item.message,
                    severity: item.severity === "error" ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
                }));

            monaco.editor.setModelMarkers(model, "justai", markers);
        }
    }, [problems, active, tabs.length]);

    // Переход к строке после открытия файла из списка ошибок.
    useEffect(() => {
        const target = pendingReveal.current;
        const editor = editorRef.current;

        if (!target || target.path !== active || !editor) {
            return;
        }

        pendingReveal.current = null;
        editor.revealLineInCenter(target.line);
        editor.setPosition({ lineNumber: target.line, column: target.column });
        editor.focus();
    }, [active, tab?.value]);

    function openProblem(path: string, line: number, column: number) {
        pendingReveal.current = { path, line, column };

        if (path === active) {
            editorRef.current?.revealLineInCenter(line);
            editorRef.current?.setPosition({ lineNumber: line, column });
            pendingReveal.current = null;
            return;
        }

        props.onOpenFile(path);
    }

    const problemCount = problems?.diagnostics.length ?? 0;

    if (tabs.length === 0) {
        return (
            <div className="editor-empty">
                <p>Open a file from the tree on the left.</p>
                <p className="muted">Ctrl+S saves. Files changed by the agent update here automatically.</p>
            </div>
        );
    }

    return (
        <div className="code-editor">
            <div className="editor-tabs" role="tablist">
                {tabs.map(item => (
                    <div
                        key={item.path}
                        role="tab"
                        aria-selected={item.path === active}
                        className={`editor-tab${item.path === active ? " active" : ""}${item.conflict !== null ? " conflict" : ""}`}
                        title={item.path}
                        onClick={() => props.onActivate(item.path)}
                        onAuxClick={event => {
                            if (event.button === 1) {
                                props.onClose(item.path);
                            }
                        }}
                    >
                        <span className={item.deleted ? "deleted" : ""}>{item.path.split("/").pop()}</span>
                        {isDirty(item) && <span className="dirty-dot" title="Unsaved changes">●</span>}
                        <button
                            className="tab-close"
                            title="Close"
                            onClick={event => {
                                event.stopPropagation();

                                if (!isDirty(item) || window.confirm(`Close ${item.path} without saving?`)) {
                                    props.onClose(item.path);
                                }
                            }}
                        >
                            ×
                        </button>
                    </div>
                ))}
            </div>

            {tab && (
                <>
                    <div className="editor-toolbar">
                        <span className="muted editor-path">{tab.path}</span>
                        <button
                            className="secondary-button"
                            disabled={!isDirty(tab) || tab.saving}
                            onClick={() => props.onSave(tab.path)}
                        >
                            {tab.saving ? "Saving…" : "Save"}
                        </button>
                        <button
                            className="secondary-button"
                            disabled={checking}
                            title="Run the project's type-check and lint commands"
                            onClick={() => void runCheck()}
                        >
                            {checking ? "Checking…" : problems ? `Problems (${problemCount})` : "Check problems"}
                        </button>
                    </div>

                    {tab.conflict !== null && (
                        <div className="notice editor-notice">
                            The file was changed on disk (possibly by the agent) while you had unsaved edits.
                            <button className="secondary-button" onClick={() => props.onTakeDisk(tab.path)}>Use disk version</button>
                            <button className="secondary-button" onClick={() => props.onKeepMine(tab.path)}>Keep my edits</button>
                        </div>
                    )}

                    {tab.deleted && <div className="notice editor-notice">The file was deleted on disk. Saving will recreate it.</div>}
                    {tab.error && <div className="error editor-notice">{tab.error}</div>}

                    <div className="editor-host">
                        <Editor
                            path={tab.path}
                            language={languageFor(tab.path)}
                            value={tab.value}
                            theme="vs-dark"
                            onMount={handleMount}
                            onChange={value => props.onChange(tab.path, value ?? "")}
                            options={{
                                fontSize: 13,
                                minimap: { enabled: false },
                                scrollBeyondLastLine: false,
                                automaticLayout: true,
                                tabSize: 4,
                                renderWhitespace: "selection",
                            }}
                        />
                    </div>

                    {showProblems && (
                        <ProblemsPanel
                            result={problems}
                            running={checking}
                            error={problemsError}
                            onOpen={openProblem}
                            onClose={() => setShowProblems(false)}
                        />
                    )}
                </>
            )}
        </div>
    );
}
