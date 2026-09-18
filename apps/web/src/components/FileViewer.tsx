import { useEffect, useState } from "react";

interface Props {

    path: string;

    content: string;

    onSave?: (
        path: string,
        content: string,
    ) => Promise<void>;

}

export function FileViewer({

    path,

    content,

    onSave,

}: Props) {

    const [value, setValue] = useState("");

    const [saving, setSaving] = useState(false);

    useEffect(() => {

        setValue(content);

    }, [content]);

    async function handleSave() {

        if (!path || !onSave) {

            return;

        }

        try {

            setSaving(true);

            await onSave(

                path,

                value,

            );

        }

        finally {

            setSaving(false);

        }

    }

    return (

        <div

            style={{

                display: "flex",

                flexDirection: "column",

                height: "100%",

            }}

        >

            <div

                style={{

                    display: "flex",

                    justifyContent: "space-between",

                    alignItems: "center",

                    marginBottom: 12,

                }}

            >

                <h3>

                    {path || "Select file"}

                </h3>

                <button

                    onClick={handleSave}

                    disabled={!path || !onSave || saving}

                >

                    {

                        saving

                            ? "Saving..."

                            : "Save"

                    }

                </button>

            </div>

            <textarea

                value={value}

                onChange={(e) =>

                    setValue(e.target.value)

                }

                disabled={!path}

                style={{

                    flex: 1,

                    resize: "none",

                    background: "#111",

                    color: "#fff",

                    border: "1px solid #333",

                    padding: 12,

                    fontFamily: "monospace",

                    fontSize: 14,

                    outline: "none",

                }}

            />

        </div>

    );

}