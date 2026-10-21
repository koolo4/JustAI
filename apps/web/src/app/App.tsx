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

import { AIChat } from "../components/AIChat";

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

    const [

        events,

        setEvents,

    ] = useState<WorkspaceEvent[]>([]);

    const socketStatus =

        useWorkspaceSocket(

            event => {

                setEvents(

                    previous => [

                        event,

                        ...previous,

                    ].slice(0, 50),

                );

            },

        );

    useEffect(() => {

        fetchWorkspaceTree()

            .then(tree => {

                setTree(tree);

                setProjectTree(tree);

            })

            .catch(console.error);

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

                    <AIChat />

                </aside>

            </main>

        </div>

    );

}