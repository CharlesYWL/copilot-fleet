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

const render = (data) => {
  for (const key of fields) $(key).value = data.settings[key];
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
};

const load = async () => {
  try {
    render(await (await fetch("/api/config")).json());
  } catch (error) {
    note("msg", "Could not read config: " + error.message, false);
  }
};

$("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = {};
  for (const key of fields) {
    const raw = $(key).value;
    body[key] = numeric.has(key) ? Number(raw) : raw;
  }
  $("save").disabled = true;
  try {
    render(await post("/api/config", body));
    note("msg", "Saved.", true);
  } catch (error) {
    note("msg", error.message, false);
  } finally {
    $("save").disabled = false;
  }
});

void load();
// The connection state changes without any interaction here, so poll it.
setInterval(load, 5000);

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
