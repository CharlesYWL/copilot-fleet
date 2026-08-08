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
</script>
</body>
</html>`;
