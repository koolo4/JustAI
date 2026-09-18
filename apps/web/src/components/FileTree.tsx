import { useState } from 'react';
import type { WorkspaceNode } from '../types/workspace';

interface Props {
    nodes: WorkspaceNode[];
    onSelect: (path: string) => void;
}

export function FileTree({
    nodes,
    onSelect,
}: Props) {
    const sortedNodes = sortNodes(nodes);

    return (
        <div>
            {sortedNodes.map((node) => (
                <TreeItem
                    key={node.path}
                    node={node}
                    onSelect={onSelect}
                />
            ))}
        </div>
    );
}

interface NodeProps {
    node: WorkspaceNode;
    onSelect: (path: string) => void;
}

function TreeItem({
    node,
    onSelect,
}: NodeProps) {
    const [opened, setOpened] = useState(false);
    const isFolder = node.type === 'folder';

    return (
        <div>
            <div
                onClick={() => {
                    if (isFolder) {
                        setOpened((value) => !value);
                    } else {
                        onSelect(node.path);
                    }
                }}
                style={{
                    cursor: 'pointer',
                    userSelect: 'none',
                    padding: '3px 0',
                }}
            >
                {isFolder ? (opened ? '📂 ' : '📁 ') : '📄 '}
                {node.name}
            </div>

            {isFolder &&
                opened &&
                node.children &&
                node.children.length > 0 && (
                    <div style={{ paddingLeft: 18 }}>
                        {sortNodes(node.children).map((child) => (
                            <TreeItem
                                key={child.path}
                                node={child}
                                onSelect={onSelect}
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