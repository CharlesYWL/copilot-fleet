import { $, el, note, post } from "./ui.js";

const logLine = (entry) => {
  const time = entry.at.length > 19 ? entry.at.slice(11, 19) : entry.at;
  return el("div", { className: "lvl-" + entry.level }, [
    el("span", { className: "at", textContent: time + "  " }),
    document.createTextNode(entry.message),
  ]);
};

const downloadJson = (value, filename) => {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
};

export const initDiagnostics = ({ loadConfig, renderConfig }) => {
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
      const pinned = view.scrollTop + view.clientHeight >= view.scrollHeight - 24;
      view.replaceChildren(...entries.map(logLine));
      if (pinned) view.scrollTop = view.scrollHeight;
    } catch (error) {
      view.replaceChildren(
        el("div", { className: "lvl-error", textContent: error.message }),
      );
    }
  };

  $("tunnelRebuild").addEventListener("click", async (event) => {
    const button = event.target;
    button.disabled = true;
    const label = button.textContent;
    button.textContent = "Rebuilding…";
    try {
      await post("/api/devtunnel/rebuild", {});
      note("tunnelMsg", "Rebuilding. Watch the status above and the log below.", true);
      await loadConfig();
      await loadLogs();
    } catch (error) {
      note("tunnelMsg", error.message, false);
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  });

  $("logRefresh").addEventListener("click", () => void loadLogs());
  $("logProblemsOnly").addEventListener("change", () => void loadLogs());
  void loadLogs();
  setInterval(loadLogs, 5000);

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
      renderConfig(await post("/api/backup", archive), { adopt: true });
      note("backupMsg", "Imported. Reconnecting…", true);
    } catch (error) {
      note("backupMsg", error.message, false);
    }
  });
};
