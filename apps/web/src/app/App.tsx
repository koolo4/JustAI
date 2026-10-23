import { useEffect, useState } from "react";

import { AgentChat, type ReviewRequest } from "../components/AgentChat";
import { DiffReview } from "../components/diff/DiffReview";
import { FileTree } from "../components/FileTree";
import { PanelBoundary } from "../components/PanelBoundary";
import { SettingsPanel } from "../components/SettingsPanel";
import { TerminalPanel } from "../components/terminal/TerminalPanel";
import { WorkspacePicker } from "../components/WorkspacePicker";
import { useIDEContext } from "../context/useIDEContext";
import { CodeEditor } from "../editor/CodeEditor";
import { useEditorTabs } from "../editor/useEditorTabs";
import { useWorkspaceSocket } from "../hooks/useWorkspaceSocket";
import { fetchWorkspaceTree } from "../services/workspaceApi";
import type { WorkspaceEvent, WorkspaceNode } from "../types/workspace";

export function App() {

    const {
        setProjectTree,
        setActiveFile,
        setActiveContent,
        addOpenedFile,
    } = useIDEContext();

    const [tree, setTree] = useState<WorkspaceNode[]>([]);
    const [review, setReview] = useState<ReviewRequest | null>(null);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [terminalOpen, setTerminalOpen] = useState(false);
    const editor = useEditorTabs();

    function refreshTree() {
        fetchWorkspaceTree()
            .then(nodes => {
                setTree(nodes);
                setProjectTree(nodes);
            })
            .catch(console.error);
    }

    // Изменения файлов (в том числе агентом) приходят по WebSocket.
    function handleWorkspaceEvent(event: WorkspaceEvent) {
        switch (event.type) {
            case "FILE_SAVED":
                if (event.path) {
                    void editor.diskChanged(event.path);
                }
                break;

            case "FILE_CREATED":
                refreshTree();
                if (event.path) {
                    void editor.diskChanged(event.path);
                }
                break;

            case "FILE_DELETED":
                refreshTree();
                if (event.path) {
                    editor.diskDeleted(event.path);
                }
                break;

            default:
                refreshTree();
        }
    }

    const socketStatus = useWorkspaceSocket(handleWorkspaceEvent);

    useEffect(() => {
        refreshTree();
    }, []);

    // Агенту подсказываем, какой файл открыт.
    const activeTab = editor.tabs.find(tab => tab.path === editor.active);

    useEffect(() => {
        setActiveFile(editor.active);
        setActiveContent(activeTab?.value ?? "");
    }, [editor.active, activeTab?.value]);

    function handleSelect(path: string) {
        addOpenedFile(path);
        void editor.open(path);
    }

    return (
        <div className="app-shell">
            <header className="topbar">
                <h1>JustAI</h1>
                <WorkspacePicker />
                <button className="secondary-button topbar-terminal" onClick={() => setTerminalOpen(open => !open)}>
                    ⌨ Terminal
                </button>
                <button className="secondary-button topbar-settings" onClick={() => setSettingsOpen(open => !open)}>
                    ⚙ Settings
                </button>
                <span className={`connection ${socketStatus}`}>
                    {socketStatus === "open" ? "● connected" : "○ connecting…"}
                </span>
            </header>

            <main className="layout">
                <aside className="panel left">
                    <PanelBoundary name="File tree">
                        <FileTree nodes={tree} onSelect={handleSelect} activePath={editor.active} />
                    </PanelBoundary>
                </aside>

                <section className="panel center">
                    <div className="center-main">
                    <PanelBoundary name="Editor">
                    {settingsOpen ? (
                        <SettingsPanel onClose={() => setSettingsOpen(false)} />
                    ) : review ? (
                        <DiffReview
                            sessionId={review.sessionId}
                            sessionTitle={review.title}
                            busy={review.busy}
                            onOpenFile={path => {
                                setReview(null);
                                handleSelect(path);
                            }}
                            onClose={() => setReview(null)}
                        />
                    ) : (
                    <CodeEditor
                        tabs={editor.tabs}
                        active={editor.active}
                        onActivate={editor.setActive}
                        onClose={editor.close}
                        onChange={editor.change}
                        onSave={path => void editor.save(path)}
                        onTakeDisk={editor.takeDisk}
                        onKeepMine={editor.keepMine}
                        onOpenFile={handleSelect}
                    />
                    )}
                    </PanelBoundary>
                    </div>

                    {terminalOpen && (
                        <PanelBoundary name="Terminal">
                            <TerminalPanel onClose={() => setTerminalOpen(false)} />
                        </PanelBoundary>
                    )}
                </section>

                <aside className="panel right">
                    <PanelBoundary name="Agent panel">
                        <AgentChat onReview={setReview} />
                    </PanelBoundary>
                </aside>
            </main>
        </div>
    );
}
