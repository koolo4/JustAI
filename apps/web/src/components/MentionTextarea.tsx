import { useMemo, useRef, useState } from "react";

import { useIDEContext } from "../context/useIDEContext";
import { applyMention, flattenPaths, mentionAt, rankPaths } from "./mentions";

interface Props {
    value: string;
    onChange(value: string): void;
    onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void;
    placeholder: string;
}

/**
 * Поле ввода с подсказками @-упоминаний: после «@» — файлы и папки проекта.
 * ↑/↓ — выбор, Enter или Tab — вставить, Esc — закрыть.
 */
export function MentionTextarea({ value, onChange, onKeyDown, placeholder }: Props) {
    const { projectTree } = useIDEContext();
    const paths = useMemo(() => flattenPaths(projectTree), [projectTree]);
    const ref = useRef<HTMLTextAreaElement>(null);
    const [caret, setCaret] = useState(0);
    const [selected, setSelected] = useState(0);
    const [dismissed, setDismissed] = useState<number | null>(null);

    const mention = mentionAt(value, caret);
    const suggestions = mention && dismissed !== mention.start ? rankPaths(paths, mention.query) : [];
    const open = suggestions.length > 0;

    function insert(path: string) {
        if (!mention) {
            return;
        }

        const next = applyMention(value, caret, mention.start, path);
        onChange(next.text);
        setCaret(next.caret);
        setSelected(0);

        requestAnimationFrame(() => {
            ref.current?.focus();
            ref.current?.setSelectionRange(next.caret, next.caret);
        });
    }

    function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
        if (open) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const step = event.key === "ArrowDown" ? 1 : -1;
                setSelected(index => (index + step + suggestions.length) % suggestions.length);
                return;
            }

            if ((event.key === "Enter" && !event.ctrlKey && !event.metaKey) || event.key === "Tab") {
                event.preventDefault();
                insert(suggestions[Math.min(selected, suggestions.length - 1)]!);
                return;
            }

            if (event.key === "Escape") {
                event.preventDefault();
                setDismissed(mention!.start);
                return;
            }
        }

        onKeyDown(event);
    }

    return (
        <div className="mention-input">
            <textarea
                ref={ref}
                rows={4}
                value={value}
                placeholder={placeholder}
                onChange={event => {
                    onChange(event.target.value);
                    setCaret(event.target.selectionStart);
                    setSelected(0);
                }}
                onSelect={event => setCaret(event.currentTarget.selectionStart)}
                onKeyDown={handleKeyDown}
            />

            {open && (
                <ul className="mention-list" role="listbox">
                    {suggestions.map((path, index) => (
                        <li
                            key={path}
                            role="option"
                            aria-selected={index === selected}
                            className={index === selected ? "selected" : ""}
                            onMouseDown={event => {
                                event.preventDefault();
                                insert(path);
                            }}
                        >
                            {path.endsWith("/") ? "📁 " : "📄 "}{path}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
