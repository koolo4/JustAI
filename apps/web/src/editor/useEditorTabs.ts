import { useCallback, useRef, useState } from "react";

import { fetchWorkspaceFile, saveWorkspaceFile } from "../services/workspaceApi";

export interface EditorTab {
    path: string;
    /** У файла есть BOM: в редакторе не показываем, при сохранении возвращаем. */
    bom: boolean;
    /** Содержимое на диске на момент последней синхронизации. */
    baseline: string;
    /** Текст в редакторе. */
    value: string;
    /** Файл изменился на диске, пока в редакторе были несохранённые правки. */
    conflict: string | null;
    deleted: boolean;
    saving: boolean;
    error: string;
}

export function isDirty(tab: EditorTab): boolean {
    return tab.value !== tab.baseline;
}

const BOM = "﻿";

async function readFile(path: string): Promise<{ text: string; bom: boolean }> {
    const { content } = await fetchWorkspaceFile(path) as { content: string };
    const bom = content.startsWith(BOM);

    return { text: bom ? content.slice(1) : content, bom };
}

/**
 * Вкладки редактора: открытые файлы, несохранённые правки, синхронизация с изменениями на диске
 * (агент правит файлы — открытая вкладка обновляется, если в ней нет правок пользователя).
 */
export function useEditorTabs() {
    const [tabs, setTabs] = useState<EditorTab[]>([]);
    const [active, setActive] = useState<string>("");
    const tabsRef = useRef(tabs);
    tabsRef.current = tabs;

    const update = useCallback((path: string, change: (tab: EditorTab) => EditorTab) => {
        setTabs(previous => previous.map(tab => tab.path === path ? change(tab) : tab));
    }, []);

    const open = useCallback(async (path: string) => {
        setActive(path);

        if (tabsRef.current.some(tab => tab.path === path)) {
            return;
        }

        const placeholder: EditorTab = { path, bom: false, baseline: "", value: "", conflict: null, deleted: false, saving: false, error: "" };
        setTabs(previous => [...previous, placeholder]);

        try {
            const { text, bom } = await readFile(path);
            update(path, tab => ({ ...tab, bom, baseline: text, value: text }));
        }
        catch (error) {
            update(path, tab => ({ ...tab, error: error instanceof Error ? error.message : String(error) }));
        }
    }, [update]);

    const close = useCallback((path: string) => {
        setTabs(previous => {
            const index = previous.findIndex(tab => tab.path === path);
            const next = previous.filter(tab => tab.path !== path);

            setActive(current => current === path
                ? (next[Math.min(index, next.length - 1)]?.path ?? "")
                : current);

            return next;
        });
    }, []);

    const change = useCallback((path: string, value: string) => {
        update(path, tab => ({ ...tab, value }));
    }, [update]);

    const save = useCallback(async (path: string) => {
        const tab = tabsRef.current.find(item => item.path === path);

        if (!tab || tab.saving) {
            return;
        }

        update(path, current => ({ ...current, saving: true, error: "" }));

        try {
            await saveWorkspaceFile(path, tab.bom ? BOM + tab.value : tab.value);
            update(path, current => ({ ...current, saving: false, baseline: tab.value, conflict: null, deleted: false }));
        }
        catch (error) {
            update(path, current => ({ ...current, saving: false, error: error instanceof Error ? error.message : String(error) }));
        }
    }, [update]);

    /** Файл изменился на диске (событие FILE_SAVED / FILE_CREATED). */
    const diskChanged = useCallback(async (path: string) => {
        const tab = tabsRef.current.find(item => item.path === path);

        if (!tab) {
            return;
        }

        let content: string;
        let bom: boolean;

        try {
            ({ text: content, bom } = await readFile(path));
        }
        catch {
            return;
        }

        update(path, current => {
            if (content === current.baseline) {
                return { ...current, bom, deleted: false };
            }

            // Нет правок пользователя — просто показываем новую версию.
            if (!isDirty(current)) {
                return { ...current, bom, baseline: content, value: content, conflict: null, deleted: false };
            }

            return { ...current, bom, conflict: content, deleted: false };
        });
    }, [update]);

    const diskDeleted = useCallback((path: string) => {
        update(path, tab => ({ ...tab, deleted: true }));
    }, [update]);

    /** Конфликт: взять версию с диска (потерять свои правки). */
    const takeDisk = useCallback((path: string) => {
        update(path, tab => tab.conflict === null
            ? tab
            : { ...tab, baseline: tab.conflict, value: tab.conflict, conflict: null });
    }, [update]);

    /** Конфликт: оставить свои правки (следующее сохранение перезапишет версию с диска). */
    const keepMine = useCallback((path: string) => {
        update(path, tab => tab.conflict === null
            ? tab
            : { ...tab, baseline: tab.conflict, conflict: null });
    }, [update]);

    return { tabs, active, setActive, open, close, change, save, diskChanged, diskDeleted, takeDisk, keepMine };
}
