import { useEffect, useState } from "react";

import { AgentChat } from "../components/AgentChat";
import { FileTree } from "../components/FileTree";
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
                <span className={`connection ${socketStatus}`}>
                    {socketStatus === "open" ? "● connected" : "○ connecting…"}
                </span>
            </header>

            <main className="layout">
                <aside className="panel left">
                    <FileTree nodes={tree} onSelect={handleSelect} activePath={editor.active} />
                </aside>

                <section className="panel center">
                    <CodeEditor
                        tabs={editor.tabs}
                        active={editor.active}
                        onActivate={editor.setActive}
                        onClose={editor.close}
                        onChange={editor.change}
                        onSave={path => void editor.save(path)}
                        onTakeDisk={editor.takeDisk}
                        onKeepMine={editor.keepMine}
                    />
                </section>

                <aside className="panel right">
                    <AgentChat />
                </aside>
            </main>
        </div>
    );
}
