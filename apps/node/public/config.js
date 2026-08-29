/**
 * The node's local config page.
 *
 * Served as a plain module rather than bundled: the node ships as a tsx
 * process, and a screen this small does not justify adding a bundler to that
 * pipeline. Nodes elsewhere on the fleet supply the names shown here, so the
 * DOM is built with `textContent` rather than assembled HTML strings.
 */

const $ = (id) => document.getElementById(id);
const fields = [
  "hostUrl",
  "nodeName",
  "maxSessions",
  "copilotCommand",
  "permissionTimeoutMs",
  "contextTier",
];
const numeric = new Set(["maxSessions", "permissionTimeoutMs"]);

const el = (tag, { dataset = {}, ...props } = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props);
  // `dataset` is read-only, so it cannot ride along with Object.assign.
  for (const [name, value] of Object.entries(dataset)) node.dataset[name] = value;
  for (const child of children) node.append(child);
  return node;
};

const post = async (path, body) => {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
};

const note = (id, text, ok) => {
  const target = $(id);
  target.className = text ? "msg " + (ok ? "ok" : "err") : "";
  target.textContent = text;
};

// ---- Application shell ----

const showPanel = (id) => {
  for (const panel of document.querySelectorAll(".panel")) {
    panel.classList.toggle("active", panel.id === id);
  }
  for (const item of document.querySelectorAll("[data-panel]")) {
    item.classList.toggle("active", item.dataset.panel === id);
  }
};

for (const item of document.querySelectorAll("[data-panel]")) {
  item.addEventListener("click", () => showPanel(item.dataset.panel));
}

// ---- Node settings ----

/**
 * What the node last said its settings are, and whether the form has been
 * edited since.
 *
 * The page polls every five seconds so the connection dot stays honest, and
 * that poll used to repaint the form along with it: a value typed into Max
 * sessions was overwritten by the node's own within five seconds, which made
 * the field impossible to change at all. Edits now belong to whoever is typing
 * until they press Save or Revert, and only the status half of the page follows
 * the poll. Nothing typed here reaches the node until Save — Revert throws the
 * edits away and shows what the node is actually running.
 */
let savedSettings = null;
let editing = false;

const showSettings = (settings) => {
  for (const key of fields) $(key).value = settings[key];
};

const setEditing = (value) => {
  editing = value;
  $("revert").disabled = !value;
  $("unsaved").textContent = value
    ? "Unsaved changes. Save applies them to this node; Revert discards them."
    : "";
};

/**
 * Repaints the page.
 *
 * `adopt` decides whether the form fields are repainted with it. It defaults to
 * "only when nobody is mid-edit", and is forced by the two events that make the
 * form stale on purpose: a save, and an imported identity.
 */
const render = (data, { adopt = !editing } = {}) => {
  savedSettings = data.settings;
  if (adopt) {
    showSettings(data.settings);
    setEditing(false);
  }
  // The Host announces its address when it moves, so this node may be dialing
  // somewhere nobody typed here. Naming the addresses it would fall back to
  // explains that, and explains why it still connects after a tunnel rotates.
  const fallbacks = data.settings.knownHostUrls || [];
  $("hostUrlFallbacks").textContent = fallbacks.length
    ? "Falls back to " + fallbacks.join(", ") + " if this address stops answering."
    : "";
  const status = data.status;
  $("dot").className = "dot " + (status.connected ? "on" : "off");
  $("conn").textContent = status.connected ? "Connected to Host" : "Not connected";
  $("meta").textContent =
    "node " +
    status.nodeId.slice(0, 8) +
    " \u00b7 v" +
    status.version +
    " \u00b7 " +
    status.activeSessions +
    " active session(s)" +
    (status.mockAgent ? " \u00b7 mock agent" : "");

  // Only a node that goes through a tunnel has one to rebuild.
  const tunnel = status.devTunnel;
  $("tunnelCard").className = tunnel ? "card" : "card hidden";
  if (tunnel) {
    $("tunnelMeta").textContent =
      tunnel.id +
      (tunnel.url ? " \u00b7 forwarding " + tunnel.url : " \u00b7 no port yet");
  }
};

const load = async (options) => {
  try {
    render(await (await fetch("/api/config")).json(), options);
  } catch (error) {
    note("msg", "Could not read config: " + error.message, false);
  }
};

// Typing anywhere in the form claims it, which is what keeps the poll off it.
// `change` is here for the browsers that only fire `input` on text controls.
for (const event of ["input", "change"]) {
  $("form").addEventListener(event, () => setEditing(true));
}

$("revert").addEventListener("click", () => {
  if (savedSettings) showSettings(savedSettings);
  setEditing(false);
  note("msg", "", true);
  // The node may have moved on while the form was held: adopt whatever it says
  // now rather than the copy this page happened to be holding.
  void load({ adopt: true });
});

$("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = {};
  for (const key of fields) {
    const raw = $(key).value;
    body[key] = numeric.has(key) ? Number(raw) : raw;
  }
  $("save").disabled = true;
  try {
    render(await post("/api/config", body), { adopt: true });
    note("msg", "Saved.", true);
  } catch (error) {
    // The edits stay in the form: a rejected save is the moment they are least
    // safe to throw away.
    note("msg", error.message, false);
  } finally {
    $("save").disabled = false;
  }
});

void load({ adopt: true });
// The connection state changes without any interaction here, so poll it. The
// form is left alone while it is being edited — see {@link render}.
setInterval(() => void load(), 5000);

// ---- Dev tunnel ----

$("tunnelRebuild").addEventListener("click", async (event) => {
  const button = event.target;
  button.disabled = true;
  const label = button.textContent;
  button.textContent = "Rebuilding…";
  try {
    await post("/api/devtunnel/rebuild", {});
    // Deliberately not "done": the CLI has to come back and report a port, and
    // the node then needs a dial to succeed. The status line above is what says
    // whether it worked, so the message points at it rather than guessing.
    note("tunnelMsg", "Rebuilding. Watch the status above and the log below.", true);
    await load();
    await loadLogs();
  } catch (error) {
    note("tunnelMsg", error.message, false);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
});

// ---- Diagnostics ----

const logLine = (entry) => {
  const time = entry.at.length > 19 ? entry.at.slice(11, 19) : entry.at;
  return el("div", { className: "lvl-" + entry.level }, [
    el("span", { className: "at", textContent: time + "  " }),
    document.createTextNode(entry.message),
  ]);
};

const loadLogs = async () => {
  const view = $("logs");
  try {
    const response = await fetch("/api/logs");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not read logs");
    const entries = $("logProblemsOnly").checked
      ? data.entries.filter((entry) => entry.level !== "info")
      : data.entries;
    if (!entries.length) {
      view.replaceChildren(
        el("div", {
          className: "at",
          textContent: $("logProblemsOnly").checked
            ? "No warnings or errors recorded."
            : "Nothing logged yet.",
        }),
      );
      return;
    }
    // Whether the reader is pinned to the newest line decides whether the poll
    // is allowed to scroll; otherwise every refresh yanks them off the line
    // they were reading.
    const pinned = view.scrollTop + view.clientHeight >= view.scrollHeight - 24;
    view.replaceChildren(...entries.map(logLine));
    if (pinned) view.scrollTop = view.scrollHeight;
  } catch (error) {
    view.replaceChildren(
      el("div", { className: "lvl-error", textContent: error.message }),
    );
  }
};

$("logRefresh").addEventListener("click", () => void loadLogs());
$("logProblemsOnly").addEventListener("change", () => void loadLogs());

void loadLogs();
setInterval(loadLogs, 5000);

const downloadJson = (value, filename) => {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
};

$("exportNode").addEventListener("click", async () => {
  try {
    const response = await fetch("/api/backup");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Export failed");
    downloadJson(
      data,
      "copilot-fleet-node-" + new Date().toISOString().slice(0, 10) + ".json",
    );
    note("backupMsg", "Downloaded.", true);
  } catch (error) {
    note("backupMsg", error.message, false);
  }
});

$("importNode").addEventListener("click", () => $("backupFile").click());

$("backupFile").addEventListener("change", async (event) => {
  const file = event.target.files && event.target.files[0];
  event.target.value = "";
  if (!file) return;
  if (
    !window.confirm(
      "Importing replaces this machine's identity and stops running agents. Continue?",
    )
  ) {
    return;
  }
  try {
    const archive = JSON.parse(await file.text());
    render(await post("/api/backup", archive), { adopt: true });
    note("backupMsg", "Imported. Reconnecting…", true);
  } catch (error) {
    note("backupMsg", error.message, false);
  }
});

// ---- Workspaces and placements (proxied through this node to the Host) ----

let workspaces = [];
let placements = [];

const workspaceItem = (workspace) =>
  el("div", { className: "item" }, [
    el("div", { className: "ws-name", textContent: workspace.name }),
    el("div", { className: "row" }, [
      el("input", {
        value: workspace.name,
        maxLength: 100,
        dataset: { ws: workspace.id },
      }),
      el("button", {
        type: "button",
        textContent: "Rename",
        dataset: { wsSave: workspace.id },
      }),
    ]),
  ]);

const placementItem = (placement) =>
  el("div", { className: "item" }, [
    el("div", {
      className: "ws-name",
      textContent: placement.workspaceName || placement.workspaceId,
    }),
    el("div", { className: "row" }, [
      el("input", {
        value: placement.localPath,
        dataset: { pl: placement.id },
      }),
      el("button", {
        type: "button",
        textContent: "Browse…",
        dataset: { plBrowse: placement.id },
      }),
      el("button", {
        type: "button",
        textContent: "Save",
        dataset: { plSave: placement.id },
      }),
    ]),
    el("div", { className: "check", dataset: { check: placement.id } }),
  ]);

const replaceChildren = (id, nodes, emptyText) => {
  $(id).replaceChildren(
    ...(nodes.length ? nodes : [el("p", { className: "empty", textContent: emptyText })]),
  );
};

const renderFleet = () => {
  replaceChildren("workspaces", workspaces.map(workspaceItem), "No workspaces yet.");
  replaceChildren(
    "placements",
    placements.map(placementItem),
    "This machine has no placement yet.",
  );

  const select = $("plWorkspace");
  const keep = select.value;
  select.replaceChildren(
    el("option", { value: "", textContent: "Select a workspace" }),
    ...workspaces.map((w) => el("option", { value: w.id, textContent: w.name })),
  );
  select.value = keep;

  const sessionPlacement = $("newSessionPlacement");
  const selectedPlacement = sessionPlacement.value;
  sessionPlacement.replaceChildren(
    el("option", { value: "", textContent: "Select a placement" }),
    ...placements.map((placement) =>
      el("option", {
        value: placement.id,
        textContent: placement.workspaceName || placement.workspaceId,
      }),
    ),
  );
  sessionPlacement.value = selectedPlacement;
};

const loadFleet = async () => {
  try {
    const response = await fetch("/api/fleet");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not reach the Host");
    workspaces = data.workspaces;
    placements = data.placements;
    renderFleet();
    note("wsMsg", "", true);
  } catch (error) {
    note("wsMsg", error.message, false);
  }
};

const checkPath = async (path, target) => {
  if (!path.trim()) {
    target.className = "check";
    target.textContent = "";
    return false;
  }
  const result = await post("/api/check-path", { path });
  target.className = "check " + (result.ok ? "ok" : "err");
  target.textContent = result.ok ? "Folder found on this machine" : result.reason;
  return result.ok;
};

$("wsAdd").addEventListener("click", async () => {
  const name = $("wsName").value.trim();
  if (!name) return;
  try {
    await post("/api/workspaces", { name, description: "" });
    $("wsName").value = "";
    await loadFleet();
    note("wsMsg", "Workspace created.", true);
  } catch (error) {
    note("wsMsg", error.message, false);
  }
});

$("workspaces").addEventListener("click", async (event) => {
  const id = event.target.dataset ? event.target.dataset.wsSave : undefined;
  if (!id) return;
  const input = document.querySelector('[data-ws="' + id + '"]');
  try {
    await post("/api/workspaces", {
      id,
      name: input.value.trim(),
      description: "",
    });
    await loadFleet();
    note("wsMsg", "Workspace renamed.", true);
  } catch (error) {
    note("wsMsg", error.message, false);
  }
});

$("placements").addEventListener("input", async (event) => {
  const id = event.target.dataset ? event.target.dataset.pl : undefined;
  if (!id) return;
  await checkPath(
    event.target.value,
    document.querySelector('[data-check="' + id + '"]'),
  );
});

$("placements").addEventListener("click", async (event) => {
  const id = event.target.dataset ? event.target.dataset.plSave : undefined;
  if (!id) return;
  const input = document.querySelector('[data-pl="' + id + '"]');
  try {
    await post("/api/placements", { id, localPath: input.value.trim() });
    await loadFleet();
    note("plMsg", "Path updated.", true);
  } catch (error) {
    note("plMsg", error.message, false);
  }
});

$("plPath").addEventListener("input", async (event) => {
  await checkPath(event.target.value, $("plCheck"));
});

$("plAdd").addEventListener("click", async () => {
  const workspaceId = $("plWorkspace").value;
  const localPath = $("plPath").value.trim();
  if (!workspaceId) {
    note("plMsg", "Pick a workspace first.", false);
    return;
  }
  try {
    await post("/api/placements", { workspaceId, localPath });
    $("plPath").value = "";
    $("plCheck").textContent = "";
    await loadFleet();
    note("plMsg", "Placement added.", true);
  } catch (error) {
    note("plMsg", error.message, false);
  }
});

void loadFleet();

// ---- Native folder picker ----
// The dialog opens on the node's own display, so this waits for someone
// sitting at that machine. The button says so while it waits, otherwise a
// remote operator just sees it hang.

const openPicker = async (targetInput, button, check) => {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Waiting…";
  try {
    const result = await post("/api/pick-folder", {
      path: targetInput.value.trim(),
    });
    if (result.ok) {
      targetInput.value = result.path;
      await checkPath(result.path, check);
    } else if (!result.canceled) {
      note("plMsg", result.reason, false);
    }
  } catch (error) {
    note("plMsg", error.message, false);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
};

$("plBrowse").addEventListener("click", (event) => {
  void openPicker($("plPath"), event.target, $("plCheck"));
});

$("placements").addEventListener("click", (event) => {
  const id = event.target.dataset ? event.target.dataset.plBrowse : undefined;
  if (!id) return;
  void openPicker(
    document.querySelector('[data-pl="' + id + '"]'),
    event.target,
    document.querySelector('[data-check="' + id + '"]'),
  );
});

// ---- Copilot session discovery and resume ----

let sessions = [];
let selectedSessionId = "";
let nextSessionCursor = "";
let sessionFilter = "all";
let sessionLoading = false;
let previewRequest;
const resumedSessionIds = new Set();

const formatDate = (value) => {
  if (!value) return "Unavailable";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Unavailable" : date.toLocaleString();
};

const timeGroup = (value) => {
  if (!value) return "Older";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Older";
  const age = Date.now() - date.valueOf();
  if (age < 24 * 60 * 60 * 1000) return "Today";
  if (age < 7 * 24 * 60 * 60 * 1000) return "This week";
  if (age < 30 * 24 * 60 * 60 * 1000) return "This month";
  return "Older";
};

const visibleSessions = () => {
  const query = $("sessionSearch").value.trim().toLocaleLowerCase();
  return sessions
    .filter((session) => {
      if (sessionFilter === "resumable" && !session.resumable) return false;
      if (sessionFilter === "legacy" && !session.legacy) return false;
      if (!query) return true;
      return [session.title, session.workspaceName]
        .filter(Boolean)
        .some((value) => value.toLocaleLowerCase().includes(query));
    })
    .sort((left, right) => {
      const leftAt = Date.parse(left.updatedAt || "") || 0;
      const rightAt = Date.parse(right.updatedAt || "") || 0;
      return rightAt - leftAt || left.id.localeCompare(right.id);
    });
};

const sessionRow = (session) =>
  el(
    "button",
    {
      type: "button",
      className: "session-item" + (session.id === selectedSessionId ? " selected" : ""),
      dataset: { sessionId: session.id },
      ariaLabel: `${session.title || "Untitled session"}, ${
        session.workspaceName || "project unavailable"
      }`,
    },
    [
      el("span", {
        className: "session-item-title",
        textContent: session.title || "Untitled session",
      }),
      el("span", {
        className: "session-item-meta",
        textContent:
          (session.workspaceName || "Project unavailable") +
          " · " +
          (session.updatedAt ? formatDate(session.updatedAt) : "Time unavailable"),
      }),
    ],
  );

const renderSessions = () => {
  const list = $("sessionList");
  const visible = visibleSessions();
  if (!visible.length) {
    list.replaceChildren(
      el("div", {
        className: "empty",
        textContent: sessions.length
          ? "No sessions match this search."
          : "No Copilot sessions were found for this user.",
      }),
    );
    return;
  }
  const nodes = [];
  let group = "";
  for (const session of visible) {
    const nextGroup = timeGroup(session.updatedAt);
    if (nextGroup !== group) {
      group = nextGroup;
      nodes.push(el("div", { className: "session-group", textContent: group }));
    }
    nodes.push(sessionRow(session));
  }
  list.replaceChildren(...nodes);
};

const selectedSession = () =>
  sessions.find((session) => session.id === selectedSessionId);

const renderSelectedSession = () => {
  const session = selectedSession();
  $("sessionEmpty").classList.toggle("hidden", Boolean(session));
  $("sessionDetail").classList.toggle("hidden", !session);
  if (!session) return;

  $("sessionProject").textContent = session.workspaceName || "Project unavailable";
  $("sessionDetailTitle").textContent = session.title || "Untitled session";
  $("sessionStatus").textContent = session.status || "Available";
  $("sessionUpdated").textContent = formatDate(session.updatedAt);
  $("sessionCreated").textContent = formatDate(session.createdAt);
  $("sessionStableId").textContent = session.id;
  const resume = $("resumeSession");
  const alreadyResumed = resumedSessionIds.has(session.id);
  resume.disabled = !session.resumable || alreadyResumed;
  resume.textContent = alreadyResumed ? "Resumed" : "Resume";
  note(
    "resumeNotice",
    session.resumable
      ? session.legacy
        ? "This older session has limited metadata, but Copilot reports that its context can be loaded."
        : ""
      : session.resumeReason || "This session cannot be resumed.",
    session.resumable,
  );
  $("loadPreview").disabled = false;
  $("sessionPreview").className = "preview empty";
  $("sessionPreview").textContent =
    "Select “Load preview” to inspect recent conversation context.";
};

const selectSession = (id) => {
  if (id === selectedSessionId) return;
  selectedSessionId = id;
  previewRequest?.abort();
  renderSessions();
  renderSelectedSession();
  showPanel("sessionPanel");
};

const loadSessions = async ({ append = false } = {}) => {
  if (sessionLoading) return;
  sessionLoading = true;
  $("sessionRefresh").disabled = true;
  if (!append) {
    $("sessionList").replaceChildren(
      el("div", { className: "skeleton-list", ariaLabel: "Loading sessions" }, [
        el("span"),
        el("span"),
        el("span"),
      ]),
    );
  }
  try {
    const suffix =
      append && nextSessionCursor
        ? "?cursor=" + encodeURIComponent(nextSessionCursor)
        : "";
    const response = await fetch("/api/sessions" + suffix);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not discover sessions");
    const incoming = Array.isArray(data.sessions) ? data.sessions : [];
    const byId = new Map(
      (append ? sessions : []).map((session) => [session.id, session]),
    );
    for (const session of incoming) byId.set(session.id, session);
    sessions = [...byId.values()];
    nextSessionCursor = data.nextCursor || "";
    $("sessionMore").classList.toggle("hidden", !nextSessionCursor);
    if (selectedSessionId && !byId.has(selectedSessionId)) selectedSessionId = "";
    renderSessions();
    renderSelectedSession();
  } catch (error) {
    $("sessionList").replaceChildren(
      el("div", { className: "msg err", textContent: error.message }),
    );
  } finally {
    sessionLoading = false;
    $("sessionRefresh").disabled = false;
  }
};

$("sessionList").addEventListener("click", (event) => {
  const row = event.target.closest("[data-session-id]");
  if (row) selectSession(row.dataset.sessionId);
});

$("sessionList").addEventListener("keydown", (event) => {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const rows = [...$("sessionList").querySelectorAll("[data-session-id]")];
  const index = rows.indexOf(event.target.closest("[data-session-id]"));
  if (index < 0) return;
  event.preventDefault();
  const next = event.key === "ArrowDown" ? index + 1 : index - 1;
  rows[Math.max(0, Math.min(rows.length - 1, next))]?.focus();
});

$("sessionSearch").addEventListener("input", renderSessions);
$("sessionRefresh").addEventListener("click", () => void loadSessions());
$("sessionMore").addEventListener("click", () => void loadSessions({ append: true }));

for (const filter of document.querySelectorAll("[data-session-filter]")) {
  filter.addEventListener("click", () => {
    sessionFilter = filter.dataset.sessionFilter;
    for (const item of document.querySelectorAll("[data-session-filter]")) {
      item.classList.toggle("active", item === filter);
    }
    renderSessions();
  });
}

$("loadPreview").addEventListener("click", async () => {
  const session = selectedSession();
  if (!session) return;
  previewRequest?.abort();
  previewRequest = new AbortController();
  const requestedId = session.id;
  const view = $("sessionPreview");
  $("loadPreview").disabled = true;
  view.className = "preview empty";
  view.textContent = "Loading supported context…";
  try {
    const response = await fetch(
      "/api/sessions/" + encodeURIComponent(requestedId) + "/preview",
      { signal: previewRequest.signal },
    );
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load session context");
    if (selectedSessionId !== requestedId) return;
    const items = Array.isArray(data.items) ? data.items : [];
    if (!items.length) {
      view.className = "preview empty";
      view.textContent = "Copilot loaded this session, but no text preview is available.";
      return;
    }
    view.className = "preview";
    view.replaceChildren(
      ...items.map((item) =>
        el("div", { className: "preview-message" }, [
          el("div", {
            className: "preview-role",
            textContent: item.role === "user" ? "You" : "Copilot",
          }),
          el("p", { className: "preview-text", textContent: item.text }),
        ]),
      ),
      ...(data.truncated
        ? [
            el("div", {
              className: "hint",
              textContent: "Preview shortened. Full context remains available on resume.",
            }),
          ]
        : []),
    );
  } catch (error) {
    if (error.name === "AbortError") return;
    view.className = "preview";
    view.replaceChildren(el("div", { className: "msg err", textContent: error.message }));
  } finally {
    if (selectedSessionId === requestedId) $("loadPreview").disabled = false;
  }
});

$("resumeSession").addEventListener("click", async () => {
  const session = selectedSession();
  if (!session || !session.resumable || resumedSessionIds.has(session.id)) return;
  const button = $("resumeSession");
  button.disabled = true;
  button.textContent = "Resuming…";
  note("resumeNotice", "Loading this session’s supported Copilot context…", true);
  try {
    const result = await post(
      "/api/sessions/" + encodeURIComponent(session.id) + "/resume",
      {},
    );
    resumedSessionIds.add(session.id);
    session.status = result.state || "starting";
    renderSessions();
    renderSelectedSession();
    note(
      "resumeNotice",
      "Resume started. The session is now available in the Fleet Host.",
      true,
    );
  } catch (error) {
    note("resumeNotice", error.message, false);
    button.disabled = false;
    button.textContent = "Resume";
  }
});

const newSessionDialog = $("newSessionDialog");
const closeNewSession = () => {
  newSessionDialog.close();
  note("newSessionMsg", "", true);
};

$("newSession").addEventListener("click", () => {
  newSessionDialog.showModal();
  $("newSessionPlacement").focus();
});
$("newSessionClose").addEventListener("click", closeNewSession);
$("newSessionCancel").addEventListener("click", closeNewSession);
$("newSessionForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("newSessionCreate");
  button.disabled = true;
  try {
    const result = await post("/api/sessions/new", {
      placementId: $("newSessionPlacement").value,
      prompt: $("newSessionPrompt").value.trim(),
      name: $("newSessionName").value.trim(),
    });
    closeNewSession();
    $("newSessionPrompt").value = "";
    $("newSessionName").value = "";
    await loadSessions();
    note(
      "resumeNotice",
      `Session ${result.sessionId ? "created" : "started"} in the Fleet Host.`,
      true,
    );
  } catch (error) {
    note("newSessionMsg", error.message, false);
  } finally {
    button.disabled = false;
  }
});

void loadSessions();
