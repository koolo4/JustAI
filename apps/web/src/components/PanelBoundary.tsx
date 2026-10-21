import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
    name: string;
    children: ReactNode;
}

interface State {
    error: Error | null;
}

/**
 * Ошибка в одной панели не должна гасить весь интерфейс: показываем её и даём перезапустить панель.
 */
export class PanelBoundary extends Component<Props, State> {

    public override state: State = { error: null };

    public static getDerivedStateFromError(error: Error): State {
        return { error };
    }

    public override componentDidCatch(error: Error, info: ErrorInfo): void {
        console.error(`[${this.props.name}] crashed`, error, info.componentStack);
    }

    public override render(): ReactNode {
        if (!this.state.error) {
            return this.props.children;
        }

        return (
            <div className="panel-crash">
                <strong>{this.props.name} stopped because of an error.</strong>
                <pre>{this.state.error.message}</pre>
                <button className="secondary-button" onClick={() => this.setState({ error: null })}>
                    Restart panel
                </button>
            </div>
        );
    }
}
