import { $, note, post } from "./ui.js";

const fields = [
  "hostUrl",
  "nodeName",
  "maxSessions",
  "copilotCommand",
  "permissionTimeoutMs",
  "contextTier",
];
const numeric = new Set(["maxSessions", "permissionTimeoutMs"]);

export const initNodeSettings = () => {
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

  const render = (data, { adopt = !editing } = {}) => {
    savedSettings = data.settings;
    if (adopt) {
      showSettings(data.settings);
      setEditing(false);
    }
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
      " · v" +
      status.version +
      " · " +
      status.activeSessions +
      " active session(s)" +
      (status.mockAgent ? " · mock agent" : "");

    const tunnel = status.devTunnel;
    $("tunnelCard").className = tunnel ? "card" : "card hidden";
    if (tunnel) {
      $("tunnelMeta").textContent =
        tunnel.id + (tunnel.url ? " · forwarding " + tunnel.url : " · no port yet");
    }
  };

  const load = async (options) => {
    try {
      render(await (await fetch("/api/config")).json(), options);
    } catch (error) {
      note("msg", "Could not read config: " + error.message, false);
    }
  };

  for (const event of ["input", "change"]) {
    $("form").addEventListener(event, () => setEditing(true));
  }

  $("revert").addEventListener("click", () => {
    if (savedSettings) showSettings(savedSettings);
    setEditing(false);
    note("msg", "", true);
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
      note("msg", error.message, false);
    } finally {
      $("save").disabled = false;
    }
  });

  void load({ adopt: true });
  setInterval(() => void load(), 5000);
  return { load, render };
};
