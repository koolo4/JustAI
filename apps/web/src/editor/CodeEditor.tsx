import "./monacoSetup";

import Editor, { type OnMount } from "@monaco-editor/react";
import { useEffect, useRef } from "react";

import { languageFor } from "./monacoSetup";
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
                </>
            )}
        </div>
    );
}
