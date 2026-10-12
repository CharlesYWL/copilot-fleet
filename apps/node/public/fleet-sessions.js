import { $, el, showPanel } from "./ui.js";

// Match Host's derived labels while keeping the metadata list a native module.
export const fleetSessionLabel = (session) => {
  const name = session.name?.trim();
  if (name) return name;
  const line = session.initialPrompt?.trim().split("\n", 1)[0]?.trim() || "";
  if (!line) return session.id.slice(0, 8);
  if (line.length <= 72) return line;
  const clipped = line.slice(0, 72);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${lastSpace > 56 ? clipped.slice(0, lastSpace) : clipped}…`;
};

/** Metadata stays native; only the selected chat mounts the shared Host entry. */
export const initFleetSessions = () => {
  const lifetime = new AbortController();
  let sessions = [];
  let selected = "";
  let nextCursor = "";
  let loaded = false;
  let request;
  let frame;
  const active = () => $("sessionPanel").classList.contains("active");
  const showSelection = () => {
    $("sessionEmpty").classList.toggle(
      "hidden",
      Boolean(selected) || !$("sessionDetail").classList.contains("hidden"),
    );
    if (selected) $("sessionDetail").classList.add("hidden");
    $("fleetChat").classList.toggle("hidden", !selected);
    $("sessionPanel").classList.toggle("has-chat", Boolean(selected));
    frame?.contentWindow?.postMessage(
      { type: "node-session", sessionId: active() ? selected : "" },
      location.origin,
    );
  };
  const render = () => {
    const query = $("fleetSessionSearch").value.trim().toLocaleLowerCase();
    const visible = sessions.filter((session) =>
      [session.name, session.initialPrompt, session.workspaceName, session.id].some(
        (value) => value?.toLocaleLowerCase().includes(query),
      ),
    );
    $("fleetSessionList").replaceChildren(
      ...(visible.length
        ? visible.map((session) =>
            el(
              "button",
              {
                type: "button",
                className: "session-item" + (session.id === selected ? " selected" : ""),
                dataset: { fleetSessionId: session.id },
              },
              [
                el("span", {
                  className: "session-item-title",
                  textContent: fleetSessionLabel(session),
                }),
                el("span", {
                  className: "session-item-meta",
                  textContent: `${session.workspaceName} · ${session.state}`,
                }),
              ],
            ),
          )
        : [
            el("div", {
              className: "empty",
              textContent: sessions.length
                ? "No matching sessions."
                : "No Fleet sessions on this node.",
            }),
          ]),
    );
    $("fleetSessionMore").classList.toggle("hidden", !nextCursor);
  };
  const load = async (append = false) => {
    if (!active() || request) return;
    const controller = new AbortController();
    request = controller;
    $("fleetSessionRefresh").disabled = true;
    try {
      const query = new URLSearchParams({ limit: "50" });
      if (append && nextCursor) query.set("cursor", nextCursor);
      const response = await fetch(`/api/fleet-sessions?${query}`, {
        signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load Fleet sessions");
      if (controller.signal.aborted) return;
      const byId = new Map(
        (append ? sessions : []).map((session) => [session.id, session]),
      );
      for (const session of data.sessions || []) byId.set(session.id, session);
      sessions = [...byId.values()];
      nextCursor = data.nextCursor || "";
      loaded = true;
      render();
    } catch (error) {
      if (!controller.signal.aborted)
        $("fleetSessionList").replaceChildren(
          el("div", { className: "msg err", textContent: error.message }),
        );
    } finally {
      if (request === controller) {
        request = undefined;
        $("fleetSessionRefresh").disabled = false;
      }
    }
  };
  const select = (id) => {
    selected = id;
    if (!frame) {
      // Separate document keeps the existing native CSS out of Host/Fluent controls.
      frame = el("iframe", {
        title: "Fleet session chat",
        src: "/session-console/index.html",
      });
      $("fleetChat").replaceChildren(frame);
    }
    showPanel("sessionPanel");
    showSelection();
    render();
  };
  $("fleetSessionList").addEventListener("click", (event) => {
    const row = event.target.closest("[data-fleet-session-id]");
    if (row) select(row.dataset.fleetSessionId);
  });
  $("fleetSessionSearch").addEventListener("input", render);
  $("fleetSessionRefresh").addEventListener("click", () => void load());
  $("fleetSessionMore").addEventListener("click", () => void load(true));
  document.addEventListener(
    "node-panel-change",
    () => {
      if (!active()) {
        request?.abort();
        request = undefined;
      } else if (!loaded) void load();
      showSelection();
    },
    { signal: lifetime.signal },
  );
  document.addEventListener(
    "node-native-session",
    () => {
      selected = "";
      showSelection();
      render();
    },
    { signal: lifetime.signal },
  );
  document.addEventListener(
    "node-fleet-session",
    (event) => {
      if (typeof event.detail !== "string") return;
      select(event.detail);
      void load();
    },
    { signal: lifetime.signal },
  );
  window.addEventListener(
    "message",
    (event) => {
      if (event.origin !== location.origin || event.source !== frame?.contentWindow)
        return;
      if (event.data?.type === "node-session-ready") showSelection();
    },
    { signal: lifetime.signal },
  );
  window.addEventListener(
    "pagehide",
    (event) => {
      request?.abort();
      request = undefined;
      frame?.contentWindow?.postMessage(
        { type: "node-session", sessionId: "" },
        location.origin,
      );
      if (!event.persisted) lifetime.abort();
    },
    { signal: lifetime.signal },
  );
  window.addEventListener(
    "pageshow",
    () => {
      if (active() && !loaded) void load();
      showSelection();
    },
    { signal: lifetime.signal },
  );
  if (active()) void load();
};
