import type { DiagnosticsResponse } from "@justai/shared";

interface Props {
    result: DiagnosticsResponse | null;
    running: boolean;
    error: string;
    onOpen(path: string, line: number, column: number): void;
    onClose(): void;
}

/**
 * Список ошибок компилятора и линтера под редактором; клик — открыть файл на нужной строке.
 */
export function ProblemsPanel({ result, running, error, onOpen, onClose }: Props) {
    const errors = result?.diagnostics.filter(item => item.severity === "error").length ?? 0;
    const warnings = (result?.diagnostics.length ?? 0) - errors;

    return (
        <div className="problems-panel">
            <div className="problems-header">
                <strong>Problems</strong>
                <span className="muted">
                    {running ? "checking…" : result ? `${errors} error(s), ${warnings} warning(s)` : ""}
                    {result && !running && result.checks.length > 0 && ` · ${result.checks.map(check => check.command).join(", ")}`}
                </span>
                <button className="link-button" onClick={onClose}>close</button>
            </div>

            {error && <div className="error">{error}</div>}

            {result && !running && result.checks.length === 0 && (
                <div className="muted problems-empty">No type-check or lint command found in this project.</div>
            )}

            {result && !running && result.checks.length > 0 && result.diagnostics.length === 0 && (
                result.unparsed
                    ? <pre className="problems-raw">{result.unparsed}</pre>
                    : <div className="muted problems-empty">No problems found.</div>
            )}

            <ul className="problems-list">
                {result?.diagnostics.map((item, index) => (
                    <li key={index} onClick={() => onOpen(item.path, item.line, item.column)} title={item.message}>
                        <span className={`problem-dot ${item.severity}`} />
                        <span className="problem-message">{item.message}</span>
                        <span className="muted problem-location">{item.path}:{item.line}:{item.column}</span>
                    </li>
                ))}
            </ul>
        </div>
    );
}
