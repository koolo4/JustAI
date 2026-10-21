import { useState } from 'react';
import type { WorkspaceNode } from '../types/workspace';

interface Props {
    nodes: WorkspaceNode[];
    onSelect: (path: string) => void;
    /** Файл, открытый в редакторе (подсвечивается). */
    activePath?: string;
}

export function FileTree({
    nodes,
    onSelect,
    activePath,
}: Props) {
    const sortedNodes = sortNodes(nodes);

    return (
        <div className="file-tree" role="tree">
            {sortedNodes.map((node) => (
                <TreeItem
                    key={node.path}
                    node={node}
                    onSelect={onSelect}
                    activePath={activePath}
                />
            ))}
        </div>
    );
}

interface NodeProps {
    node: WorkspaceNode;
    onSelect: (path: string) => void;
    activePath: string | undefined;
}

function TreeItem({
    node,
    onSelect,
    activePath,
}: NodeProps) {
    const isFolder = node.type === 'folder';
    // Папки на пути к открытому файлу раскрываются сами.
    const [opened, setOpened] = useState(() => Boolean(activePath?.startsWith(`${node.path}/`)));
    const active = activePath === node.path;

    return (
        <div role="treeitem" aria-expanded={isFolder ? opened : undefined}>
            <div
                className={`tree-row${active ? ' active' : ''}`}
                onClick={() => {
                    if (isFolder) {
                        setOpened((value) => !value);
                    } else {
                        onSelect(node.path);
                    }
                }}
            >
                {isFolder ? (opened ? '📂 ' : '📁 ') : '📄 '}
                {node.name}
            </div>

            {isFolder &&
                opened &&
                node.children &&
                node.children.length > 0 && (
                    <div style={{ paddingLeft: 14 }}>
                        {sortNodes(node.children).map((child) => (
                            <TreeItem
                                key={child.path}
                                node={child}
                                onSelect={onSelect}
                                activePath={activePath}
                            />
                        ))}
                    </div>
                )}
        </div>
    );
}

function sortNodes(nodes: WorkspaceNode[]): WorkspaceNode[] {
    return [...nodes].sort((a, b) => {
        if (a.type !== b.type) {
            return a.type === 'folder' ? -1 : 1;
        }

        return a.name.localeCompare(b.name, 'ru', {
            numeric: true,
            sensitivity: 'base',
        });
    });
}
