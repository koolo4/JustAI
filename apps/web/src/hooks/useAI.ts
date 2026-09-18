import { useState } from "react";

import { askAI } from "../services/aiApi";

import type { AIMessage } from "../types/ai";

export function useAI() {

    const [messages, setMessages] =
        useState<AIMessage[]>([]);

    const [loading, setLoading] =
        useState(false);

    async function send(
        prompt: string,
    ) {
        if (!prompt.trim()) {
            return;
        }

        setMessages(previous => [
            ...previous,
            {
                role: "user",
                content: prompt,
            },
        ]);

        setLoading(true);

        try {
            const result =
                await askAI({
                    prompt,
                    activeFile: "",
                    activeContent: "",
                    openedFiles: [],
                    projectTree: [],
                });

            setMessages(previous => [
                ...previous,
                {
                    role: "assistant",
                    content: result,
                },
            ]);
        }
        finally {
            setLoading(false);
        }
    }

    return {
        messages,
        loading,
        send,
    };
}
