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
