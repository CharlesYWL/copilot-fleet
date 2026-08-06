import { useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  BrowserMessage,
  FleetNode,
  FleetSession,
  Placement,
  SessionEvent,
  Workspace,
} from "@fleet/protocol";

type Snapshot = {
  nodes: FleetNode[];
  workspaces: Workspace[];
  placements: Placement[];
  sessions: FleetSession[];
};

const terminal = new Set(["stopped", "completed", "failed"]);

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>({
    nodes: [],
    workspaces: [],
    placements: [],
    sessions: [],
  });
  const [page, setPage] = useState<"dashboard" | "nodes" | "workspaces">("dashboard");
  const [selected, setSelected] = useState<string>();
  const [events, setEvents] = useState<Record<string, SessionEvent[]>>({});
  const [error, setError] = useState("");

  useEffect(() => {
    void api<Snapshot>("/api/snapshot").then(setSnapshot).catch(showError);
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/ws/browser`);
    socket.onmessage = ({ data }) => {
      const message = parseBrowserMessage(String(data));
      if (!message) {
        showError("Malformed live update");
        socket.close(1007, "Malformed JSON");
        return;
      }
      if (message.type === "snapshot") {
        setSnapshot(message.data as Snapshot);
      } else if (message.type === "node") {
        setSnapshot((value) => ({
          ...value,
          nodes: upsert(value.nodes, message.node),
        }));
      } else if (message.type === "session") {
        setSnapshot((value) => ({
          ...value,
          sessions: upsert(value.sessions, message.session),
        }));
      } else if (message.type === "event") {
        setEvents((value) => ({
          ...value,
          [message.event.sessionId]: [
            ...(value[message.event.sessionId] ?? []).filter(
              (item) => item.eventId !== message.event.eventId,
            ),
            message.event,
          ].sort((a, b) => a.sequence - b.sequence),
        }));
      }
    };
    return () => socket.close();
  }, []);

  useEffect(() => {
    if (!selected) return;
    void api<SessionEvent[]>(`/api/sessions/${selected}/events`)
      .then((items) => setEvents((value) => ({ ...value, [selected]: items })))
      .catch(showError);
  }, [selected]);

  const liveSessions = snapshot.sessions.filter((session) => !terminal.has(session.state));
  const waitingPermissions = pendingPermissionCount(Object.values(events).flat());
  const active = snapshot.sessions.find((session) => session.id === selected);

  function showError(reason: unknown) {
    setError(reason instanceof Error ? reason.message : String(reason));
    setTimeout(() => setError(""), 5_000);
  }

  async function command(path: string, body?: unknown) {
    try {
      await api(path, {
        method: "POST",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (reason) {
      showError(reason);
    }
  }

  return (
    <div className="app-shell">
      <header>
        <div className="brand">
          <div className="logo">CF</div>
          <div>
            <strong>Copilot Fleet</strong>
            <span>Agent control plane</span>
          </div>
        </div>
        <nav>
          {(["dashboard", "nodes", "workspaces"] as const).map((item) => (
            <button
              className={page === item ? "active" : ""}
              key={item}
              onClick={() => setPage(item)}
            >
              {item}
            </button>
          ))}
        </nav>
        <div className="stats">
          <Stat label="Nodes online" value={snapshot.nodes.filter((node) => node.online).length} />
          <Stat label="Live sessions" value={liveSessions.length} />
          <Stat label="Permissions" value={waitingPermissions} warn={waitingPermissions > 0} />
        </div>
      </header>

      <main>
        {page === "dashboard" && (
          <Dashboard
            sessions={liveSessions}
            placements={snapshot.placements}
            nodes={snapshot.nodes}
            onOpen={setSelected}
            onCommand={command}
          />
        )}
        {page === "nodes" && <Nodes nodes={snapshot.nodes} />}
        {page === "workspaces" && (
          <Workspaces
            data={snapshot}
            onChanged={() => api<Snapshot>("/api/snapshot").then(setSnapshot).catch(showError)}
            showError={showError}
          />
        )}
      </main>

      {active && (
        <SessionDrawer
          session={active}
          events={events[active.id] ?? []}
          onClose={() => setSelected(undefined)}
          onCommand={command}
        />
      )}
      {error && <div className="toast">{error}</div>}
    </div>
  );
}

function Stat({ label, value, warn = false }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className={warn ? "stat warn" : "stat"}>
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

function Dashboard({
  sessions,
  placements,
  nodes,
  onOpen,
  onCommand,
}: {
  sessions: FleetSession[];
  placements: Placement[];
  nodes: FleetNode[];
  onOpen: (id: string) => void;
  onCommand: (path: string, body?: unknown) => Promise<void>;
}) {
  const [placementId, setPlacementId] = useState("");
  const [prompt, setPrompt] = useState("");
  const eligible = placements.filter((placement) =>
    nodes.some((node) => node.id === placement.nodeId && node.online),
  );

  async function start(event: FormEvent) {
    event.preventDefault();
    await onCommand("/api/sessions", { placementId, prompt });
    setPrompt("");
  }

  return (
    <>
      <section className="page-title">
        <div>
          <p className="eyebrow">LIVE OPERATIONS</p>
          <h1>Sessions</h1>
          <p>Supervise active Copilot processes across your fleet.</p>
        </div>
        <form className="start-form" onSubmit={start}>
          <select
            value={placementId}
            onChange={(event) => setPlacementId(event.target.value)}
            required
          >
            <option value="">Choose workspace placement</option>
            {eligible.map((placement) => (
              <option key={placement.id} value={placement.id}>
                {placement.workspaceName} · {placement.nodeName}
              </option>
            ))}
          </select>
          <input
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Initial prompt"
            required
          />
          <button className="primary">Start session</button>
        </form>
      </section>
      {sessions.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">↗</div>
          <h2>No live sessions</h2>
          <p>Register a node, add a placement, then launch an agent above.</p>
        </div>
      ) : (
        <section className="session-grid">
          {sessions.map((session) => (
            <article className="session-card" key={session.id}>
              <div className="card-top">
                <Status state={session.state} />
                <span className="elapsed">{elapsed(session.createdAt)}</span>
              </div>
              <h2>{session.workspaceName}</h2>
              <p className="node-label">{session.nodeName}</p>
              <div className="activity">
                <span>Current activity</span>
                <strong>{session.currentActivity}</strong>
              </div>
              <div className="last-text">
                {session.lastText || "Waiting for the first streamed event…"}
              </div>
              <div className="actions">
                <button className="primary" onClick={() => onOpen(session.id)}>
                  Open
                </button>
                <button
                  disabled={session.state !== "running"}
                  onClick={() => onCommand(`/api/sessions/${session.id}/cancel`)}
                >
                  Cancel
                </button>
                <button
                  className="danger"
                  onClick={() => onCommand(`/api/sessions/${session.id}/stop`)}
                >
                  Stop
                </button>
              </div>
            </article>
          ))}
        </section>
      )}
    </>
  );
}

function Nodes({ nodes }: { nodes: FleetNode[] }) {
  return (
    <>
      <section className="page-title">
        <div>
          <p className="eyebrow">INFRASTRUCTURE</p>
          <h1>Nodes</h1>
          <p>Connected machines and available session capacity.</p>
        </div>
      </section>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Name</th>
              <th>Platform</th>
              <th>Capacity</th>
              <th>Version</th>
              <th>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {nodes.map((node) => (
              <tr key={node.id}>
                <td><span className={node.online ? "online-dot" : "offline-dot"} />{node.online ? "Online" : "Offline"}</td>
                <td><strong>{node.name}</strong></td>
                <td>{node.os} / {node.arch}</td>
                <td>{node.activeSessions} / {node.maxSessions}</td>
                <td>{node.version}</td>
                <td>{new Date(node.lastHeartbeat).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Workspaces({
  data,
  onChanged,
  showError,
}: {
  data: Snapshot;
  onChanged: () => void;
  showError: (error: unknown) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [nodeId, setNodeId] = useState("");
  const [localPath, setLocalPath] = useState("");

  async function createWorkspace(event: FormEvent) {
    event.preventDefault();
    try {
      await api("/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ name, description }),
      });
      setName("");
      setDescription("");
      onChanged();
    } catch (error) {
      showError(error);
    }
  }

  async function createPlacement(event: FormEvent) {
    event.preventDefault();
    try {
      await api("/api/placements", {
        method: "POST",
        body: JSON.stringify({ workspaceId, nodeId, localPath }),
      });
      setLocalPath("");
      onChanged();
    } catch (error) {
      showError(error);
    }
  }

  return (
    <>
      <section className="page-title">
        <div>
          <p className="eyebrow">PROJECT MAP</p>
          <h1>Workspaces & placements</h1>
          <p>Map each logical project to its machine-local absolute path.</p>
        </div>
      </section>
      <div className="two-column">
        <section className="panel">
          <h2>Create workspace</h2>
          <form className="stack-form" onSubmit={createWorkspace}>
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Workspace name" required />
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Description" />
            <button className="primary">Create</button>
          </form>
        </section>
        <section className="panel">
          <h2>Add placement</h2>
          <form className="stack-form" onSubmit={createPlacement}>
            <select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)} required>
              <option value="">Workspace</option>
              {data.workspaces.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            <select value={nodeId} onChange={(event) => setNodeId(event.target.value)} required>
              <option value="">Node</option>
              {data.nodes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            <input value={localPath} onChange={(event) => setLocalPath(event.target.value)} placeholder="C:\code\project or /srv/project" required />
            <button className="primary">Add placement</button>
          </form>
        </section>
      </div>
      <div className="workspace-list">
        {data.workspaces.map((workspace) => (
          <article className="workspace-card" key={workspace.id}>
            <div><h2>{workspace.name}</h2><p>{workspace.description || "No description"}</p></div>
            <div className="placements">
              {data.placements.filter((item) => item.workspaceId === workspace.id).map((item) => (
                <div key={item.id}><strong>{item.nodeName}</strong><code>{item.localPath}</code></div>
              ))}
            </div>
          </article>
        ))}
      </div>
    </>
  );
}

function SessionDrawer({
  session,
  events,
  onClose,
  onCommand,
}: {
  session: FleetSession;
  events: SessionEvent[];
  onClose: () => void;
  onCommand: (path: string, body?: unknown) => Promise<void>;
}) {
  const [prompt, setPrompt] = useState("");
  const permission = useMemo(() => {
    const handled = new Set(
      events
        .filter((event) => event.type === "permission_result")
        .map((event) => String(event.payload.requestId)),
    );
    return [...events]
      .reverse()
      .find(
        (event) =>
          event.type === "permission" &&
          !handled.has(String(event.payload.requestId)),
      );
  }, [events]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    await onCommand(`/api/sessions/${session.id}/prompt`, { prompt });
    setPrompt("");
  }

  const options = (permission?.payload.options ?? []) as Array<{
    optionId: string;
    name: string;
    kind: string;
  }>;
  const allowOption = options.find((option) => option.kind === "allow_once");

  return (
    <div className="drawer-backdrop" onMouseDown={onClose}>
      <aside className="drawer" onMouseDown={(event) => event.stopPropagation()}>
        <div className="drawer-head">
          <div>
            <Status state={session.state} />
            <h2>{session.workspaceName}</h2>
            <p>{session.nodeName} · {session.id.slice(0, 8)}</p>
          </div>
          <button className="icon-button" onClick={onClose}>×</button>
        </div>
        {permission && (
          <div className="permission-banner">
            <div><b>Permission required</b><span>{String(permission.payload.title ?? "Tool request")}</span></div>
            <button
              className="allow"
              onClick={() =>
                onCommand(`/api/sessions/${session.id}/permission`, {
                  requestId: permission.payload.requestId,
                  outcome: "allow_once",
                  ...(allowOption ? { optionId: allowOption.optionId } : {}),
                })
              }
            >Allow once</button>
            <button
              onClick={() =>
                onCommand(`/api/sessions/${session.id}/permission`, {
                  requestId: permission.payload.requestId,
                  outcome: "deny",
                })
              }
            >Deny</button>
          </div>
        )}
        <div className="timeline">
          {events.length === 0 && <div className="timeline-empty">Waiting for events…</div>}
          {events.map((event) => <EventRow event={event} key={event.eventId} />)}
        </div>
        <div className="drawer-controls">
          <form onSubmit={submit}>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder={session.state === "idle" ? "Send a follow-up prompt…" : "Available when session is idle"}
              disabled={session.state !== "idle"}
              required
            />
            <button className="primary" disabled={session.state !== "idle"}>Send</button>
          </form>
          <div className="control-row">
            <button disabled={session.state !== "running"} onClick={() => onCommand(`/api/sessions/${session.id}/cancel`)}>Cancel active turn</button>
            <button className="danger" onClick={() => onCommand(`/api/sessions/${session.id}/stop`)}>Stop process</button>
          </div>
        </div>
      </aside>
    </div>
  );
}

function EventRow({ event }: { event: SessionEvent }) {
  const text =
    typeof event.payload.text === "string"
      ? event.payload.text
      : event.type === "state"
        ? String(event.payload.activity ?? event.payload.state)
        : event.type === "tool"
          ? `${String(event.payload.title ?? "Tool")} · ${String(event.payload.status ?? "")}`
          : event.type === "permission"
            ? `Permission: ${String(event.payload.title ?? "tool request")}`
            : event.type === "turn_complete"
              ? `Turn complete · ${String(event.payload.stopReason)}`
              : event.type === "error"
                ? String(event.payload.message)
                : "";
  return (
    <div className={`event event-${event.type}`}>
      <span className="event-time">{new Date(event.createdAt).toLocaleTimeString()}</span>
      <div><b>{event.type.replace("_", " ")}</b><p>{text}</p></div>
    </div>
  );
}

function Status({ state }: { state: string }) {
  return <span className={`status status-${state}`}><i />{state}</span>;
}

function elapsed(createdAt: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(createdAt)) / 60_000));
  return minutes < 1 ? "just now" : `${minutes}m`;
}

function upsert<T extends { id: string }>(items: T[], next: T): T[] {
  return items.some((item) => item.id === next.id)
    ? items.map((item) => (item.id === next.id ? next : item))
    : [next, ...items];
}

function pendingPermissionCount(events: SessionEvent[]): number {
  const pending = new Set<string>();
  for (const event of events) {
    const requestId = String(event.payload.requestId ?? "");
    if (!requestId) continue;
    if (event.type === "permission") pending.add(requestId);
    if (event.type === "permission_result") pending.delete(requestId);
  }
  return pending.size;
}

function parseBrowserMessage(text: string): BrowserMessage | undefined {
  try {
    return JSON.parse(text) as BrowserMessage;
  } catch {
    return undefined;
  }
}

async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}
