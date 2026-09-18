import type { WorkspaceEvent } from '../types/workspace';

interface Props {
    events: WorkspaceEvent[];
}

export function EventConsole({ events }: Props) {
    return (
        <div>
            <h2>Events</h2>
            <div className="events">
                {events.length === 0 ? (
                    <p>No events yet...</p>
                ) : (
                    events.map((event, index) => (
                        <pre key={index}>{JSON.stringify(event, null, 2)}</pre>
                    ))
                )}
            </div>
        </div>
    );
}