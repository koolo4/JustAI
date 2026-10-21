import { useEffect, useRef, useState } from "react";

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

    // Файл изменился на диске, пока в редакторе были несохранённые правки.
    const [conflict, setConflict] = useState(false);

    const baseline = useRef("");

    const currentPath = useRef("");

    useEffect(() => {

        const switchedFile = currentPath.current !== path;
        const dirty = value !== baseline.current;

        currentPath.current = path;
        baseline.current = content;

        if (switchedFile || !dirty) {

            setValue(content);
            setConflict(false);

        }
        else if (content !== value) {

            setConflict(true);

        }

    }, [content, path]);

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

            setConflict(false);

        }

        finally {

            setSaving(false);

        }

    }

    function reloadFromDisk() {

        setValue(baseline.current);
        setConflict(false);

    }

    const dirty = Boolean(path) && value !== baseline.current;

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

                    {path || "Select file"}{dirty ? " •" : ""}

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

            {conflict && (

                <div className="notice" style={{ marginTop: 0, marginBottom: 8 }}>

                    The file was changed on disk (possibly by the agent) while you had unsaved edits.{" "}

                    <button className="secondary-button" onClick={reloadFromDisk}>

                        Load disk version

                    </button>

                </div>

            )}

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
