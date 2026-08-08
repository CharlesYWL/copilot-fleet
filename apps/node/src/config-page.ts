/**
 * Served as a single inlined page: the node ships as a plain tsx process, and a
 * config screen this small does not justify adding a bundler to that pipeline.
 */
export const CONFIG_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Copilot Fleet node</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; padding: 32px 20px; background: #16181d; color: #e6e8ec;
    font: 14px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif;
    display: flex; justify-content: center;
  }
  main { width: 100%; max-width: 560px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #9aa1ad; margin: 0 0 24px; }
  .card {
    background: #1d2027; border: 1px solid #2c313a; border-radius: 10px;
    padding: 20px; margin-bottom: 16px;
  }
  .status { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #6b7280; }
  .dot.on { background: #37b24d; }
  .dot.off { background: #e03131; }
  .meta { color: #9aa1ad; font-size: 13px; }
  label { display: block; margin-bottom: 14px; }
  .label { display: block; margin-bottom: 5px; font-weight: 600; }
  .hint { display: block; color: #9aa1ad; font-size: 12px; margin-top: 4px; }
  input {
    width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 6px;
    border: 1px solid #39404b; background: #12141a; color: #e6e8ec; font: inherit;
  }
  input:focus-visible { outline: 2px solid #4c8dff; outline-offset: 1px; }
  button {
    padding: 9px 18px; border-radius: 6px; border: 0; background: #3b6fd4;
    color: #fff; font: inherit; font-weight: 600; cursor: pointer;
  }
  button:disabled { opacity: .55; cursor: default; }
  button:focus-visible { outline: 2px solid #9dc0ff; outline-offset: 2px; }
  .msg { margin-top: 14px; padding: 10px 12px; border-radius: 6px; font-size: 13px; }
  .msg.ok { background: #1c3325; border: 1px solid #2f6b41; }
  .msg.err { background: #35201f; border: 1px solid #7d3a37; }
  .warn { background: #33291a; border: 1px solid #7a5c2a; border-radius: 6px;
          padding: 10px 12px; font-size: 13px; margin-bottom: 18px; }
  h2 { font-size: 15px; margin: 0 0 4px; }
  .row { display: flex; gap: 8px; align-items: flex-start; margin-bottom: 10px; }
  .row input { flex: 1; min-width: 0; }
  .row button { flex: 0 0 auto; background: #2a3140; }
  .empty { color: #9aa1ad; font-size: 13px; margin: 8px 0 0; }
  .ws-name { font-weight: 600; margin-bottom: 4px; }
  .item { border-top: 1px solid #2c313a; padding-top: 14px; margin-top: 14px; }
  .item:first-of-type { border-top: 0; padding-top: 0; margin-top: 0; }
  select {
    width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 6px;
    border: 1px solid #39404b; background: #12141a; color: #e6e8ec; font: inherit;
  }
  .check { font-size: 12px; margin-top: 4px; min-height: 16px; }
  .check.ok { color: #6bcf7f; }
  .check.err { color: #f08c8c; }
</style>
</head>
<body>
<main>
  <h1>Copilot Fleet node</h1>
  <p class="sub">Local configuration. Reachable from this machine only.</p>

  <div class="card">
    <div class="status">
      <span class="dot" id="dot" aria-hidden="true"></span>
      <strong id="conn">Loading…</strong>
    </div>
    <div class="meta" id="meta"></div>
  </div>

  <form class="card" id="form">
    <div class="warn">
      Pointing this node at a different Host lets that Host run commands on this
      machine. Only enter a URL you control.
    </div>

    <label>
      <span class="label">Host URL</span>
      <input id="hostUrl" name="hostUrl" type="url" required
             placeholder="https://example.trycloudflare.com" />
      <span class="hint">Saving reconnects immediately. Running sessions keep going.</span>
    </label>

    <label>
      <span class="label">Node name</span>
      <input id="nodeName" name="nodeName" required maxlength="120" />
      <span class="hint">Changing this re-registers the node with the Host.</span>
    </label>

    <label>
      <span class="label">Max concurrent sessions</span>
      <input id="maxSessions" name="maxSessions" type="number" min="1" max="64" required />
    </label>

    <label>
      <span class="label">Copilot command</span>
      <input id="copilotCommand" name="copilotCommand" placeholder="copilot" />
      <span class="hint">Leave empty to use <code>copilot</code> from PATH.</span>
    </label>

    <label>
      <span class="label">Permission timeout (ms)</span>
      <input id="permissionTimeoutMs" name="permissionTimeoutMs" type="number"
             min="1000" max="3600000" required />
      <span class="hint">How long a non-YOLO session waits for your approval.</span>
    </label>

    <button type="submit" id="save">Save</button>
    <div id="msg"></div>
  </form>

  <div class="card">
    <h2>Workspaces</h2>
    <p class="sub" style="margin-bottom:14px">Shared across the fleet.</p>
    <div id="workspaces"></div>
    <div class="item">
      <label>
        <span class="label">New workspace</span>
        <div class="row">
          <input id="wsName" maxlength="100" placeholder="Project name" />
          <button type="button" id="wsAdd">Create</button>
        </div>
      </label>
    </div>
    <div id="wsMsg"></div>
  </div>

  <div class="card">
    <h2>Placements on this machine</h2>
    <p class="sub" style="margin-bottom:14px">
      Where each workspace lives locally. Paths are checked against this
      machine before they are saved.
    </p>
    <div id="placements"></div>
    <div class="item">
      <span class="label">Add a placement here</span>
      <label>
        <select id="plWorkspace"><option value="">Select a workspace</option></select>
      </label>
      <div class="row">
        <input id="plPath" placeholder="/Users/me/project" />
        <button type="button" id="plBrowse">Browse…</button>
        <button type="button" id="plAdd">Add</button>
      </div>
      <div class="hint">Browse opens a folder dialog on this node's own screen.</div>
      <div class="check" id="plCheck"></div>
    </div>
    <div id="plMsg"></div>
  </div>
</main>

<script>
  const $ = (id) => document.getElementById(id);
  const fields = ["hostUrl", "nodeName", "maxSessions", "copilotCommand", "permissionTimeoutMs"];
  const numeric = new Set(["maxSessions", "permissionTimeoutMs"]);

  const render = (data) => {
    for (const key of fields) $(key).value = data.settings[key];
    const s = data.status;
    $("dot").className = "dot " + (s.connected ? "on" : "off");
    $("conn").textContent = s.connected ? "Connected to Host" : "Not connected";
    $("meta").textContent =
      "node " + s.nodeId.slice(0, 8) + " \\u00b7 v" + s.version + " \\u00b7 " +
      s.activeSessions + " active session(s)" + (s.mockAgent ? " \\u00b7 mock agent" : "");
  };

  const show = (text, ok) => {
    const el = $("msg");
    el.className = "msg " + (ok ? "ok" : "err");
    el.textContent = text;
  };

  const load = async () => {
    try {
      render(await (await fetch("/api/config")).json());
    } catch (error) {
      show("Could not read config: " + error.message, false);
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
      const response = await fetch("/api/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Save failed");
      render(data);
      show("Saved.", true);
    } catch (error) {
      show(error.message, false);
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

  // Names come from anyone on the fleet, so they are never interpolated raw.
  const esc = (value) => {
    const el = document.createElement("div");
    el.textContent = value == null ? "" : String(value);
    return el.innerHTML;
  };

  const note = (id, text, ok) => {
    const el = $(id);
    el.className = text ? "msg " + (ok ? "ok" : "err") : "";
    el.textContent = text;
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

  const renderFleet = () => {
    $("workspaces").innerHTML = workspaces.length
      ? workspaces
          .map(
            (w) =>
              '<div class="item"><div class="ws-name">' + esc(w.name) +
              '</div><div class="row"><input data-ws="' + esc(w.id) +
              '" value="' + esc(w.name) + '" maxlength="100" />' +
              '<button type="button" data-ws-save="' + esc(w.id) +
              '">Rename</button></div></div>',
          )
          .join("")
      : '<p class="empty">No workspaces yet.</p>';

    $("placements").innerHTML = placements.length
      ? placements
          .map(
            (p) =>
              '<div class="item"><div class="ws-name">' +
              esc(p.workspaceName || p.workspaceId) +
              '</div><div class="row"><input data-pl="' + esc(p.id) +
              '" value="' + esc(p.localPath) + '" />' +
              '<button type="button" data-pl-browse="' + esc(p.id) +
              '">Browse…</button>' +
              '<button type="button" data-pl-save="' + esc(p.id) +
              '">Save</button></div>' +
              '<div class="check" data-check="' + esc(p.id) + '"></div></div>',
          )
          .join("")
      : '<p class="empty">This machine has no placement yet.</p>';

    const select = $("plWorkspace");
    const keep = select.value;
    select.innerHTML =
      '<option value="">Select a workspace</option>' +
      workspaces
        .map((w) => '<option value="' + esc(w.id) + '">' + esc(w.name) + "</option>")
        .join("");
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
      await post("/api/workspaces", { id, name: input.value.trim(), description: "" });
      await loadFleet();
      note("wsMsg", "Workspace renamed.", true);
    } catch (error) {
      note("wsMsg", error.message, false);
    }
  });

  $("placements").addEventListener("input", async (event) => {
    const id = event.target.dataset ? event.target.dataset.pl : undefined;
    if (!id) return;
    await checkPath(event.target.value, document.querySelector('[data-check="' + id + '"]'));
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
</script>
</body>
</html>`;
