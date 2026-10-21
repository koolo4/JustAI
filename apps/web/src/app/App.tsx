import { useEffect, useMemo, useState } from "react";

import { fetchWorkspaceTree, fetchWorkspaceFile, saveWorkspaceFile } from "../services/workspaceApi";

import { useWorkspaceSocket } from "../hooks/useWorkspaceSocket";

import { useIDEContext } from "../context/useIDEContext";

import type {

    WorkspaceNode,

    WorkspaceEvent,

} from "../types/workspace";

import { FileTree } from "../components/FileTree";

import { FileViewer } from "../components/FileViewer";

import { AgentChat } from "../components/AgentChat";

export function App() {

    const {

        setProjectTree,

        setActiveFile,

        setActiveContent,

        addOpenedFile,

    } = useIDEContext();

    const [

        tree,

        setTree,

    ] = useState<WorkspaceNode[]>([]);

    const [

        selectedPath,

        setSelectedPath,

    ] = useState("");

    const [

        fileContent,

        setFileContent,

    ] = useState("");

    function refreshTree() {

        fetchWorkspaceTree()

            .then(tree => {

                setTree(tree);

                setProjectTree(tree);

            })

            .catch(console.error);

    }

    // Изменения файлов (в том числе агентом) приходят по WebSocket.
    function handleWorkspaceEvent(event: WorkspaceEvent) {

        if (event.type !== 'FILE_SAVED') {

            refreshTree();

        }

        const changed = event.path ?? event.newPath;

        if (selectedPath && changed === selectedPath) {

            fetchWorkspaceFile(selectedPath)

                .then((json: { content: string }) => {

                    setFileContent(json.content);

                    setActiveContent(json.content);

                })

                .catch(console.error);

        }

    }

    const socketStatus =

        useWorkspaceSocket(

            handleWorkspaceEvent,

        );

    useEffect(() => {

        refreshTree();

    }, []);

    async function handleSelect(

        path: string,

    ) {

        setSelectedPath(path);

        setActiveFile(path);

        addOpenedFile(path);

        const json =

            await fetchWorkspaceFile(path) as { content: string };

        setFileContent(

            json.content,

        );

        setActiveContent(

            json.content,

        );

    }

    const header = useMemo(

        () =>

            socketStatus === "open"

                ? "WebSocket: connected"

                : "WebSocket: connecting...",

        [

            socketStatus,

        ],

    );

    return (

        <div className="app-shell">

            <header className="topbar">

                <h1>

                    JustAI

                </h1>

                <span>

                    {header}

                </span>

            </header>

            <main className="layout">

                <aside className="panel left">

                    <FileTree

                        nodes={tree}

                        onSelect={handleSelect}

                    />

                </aside>

                <section className="panel center">

                    <FileViewer
                        path={selectedPath}
                        content={fileContent}
                        onSave={async (path, content) => {
                            await saveWorkspaceFile(path, content);
                            setFileContent(content);
                            setActiveContent(content);
                        }}
                    />

                </section>

                <aside className="panel right">

                    <AgentChat />

                </aside>

            </main>

        </div>

    );

}