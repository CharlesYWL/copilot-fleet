import { $, note } from "./ui.js";

const upgradeMessage = "Upgrade Node to view and edit the persistent allowlist.";
const conflictMessage =
  "The saved allowlist changed elsewhere. Your draft has been kept. " +
  "Discard draft and reload to review the latest saved entries before saving.";
const formatEntries = (entries) =>
  entries.length
    ? "[\n" + entries.map((entry) => "  " + JSON.stringify(entry)).join(",\n") + "\n]"
    : "[]";

const requestPermissions = async (init) => {
  const response = await fetch("/api/command-permissions", init);
  if (response.status === 503 || response.status === 404) {
    throw Object.assign(new Error(upgradeMessage), { status: 503 });
  }
  const data = await response.json();
  if (response.status === 409) {
    throw Object.assign(
      new Error((data.error ? data.error + " " : "") + conflictMessage),
      { status: 409 },
    );
  }
  if (!response.ok) throw new Error(data.error || "Request failed");
  if (!Number.isInteger(data?.version)) {
    throw new Error("Invalid command permissions response");
  }
  if (!Object.hasOwn(data, "entries")) {
    throw Object.assign(new Error(upgradeMessage), { status: 503 });
  }
  if (!Array.isArray(data.entries)) {
    throw new Error("Invalid command permissions response: entries must be an array");
  }
  return { version: data.version, entries: data.entries };
};

export const initCommandPermissions = () => {
  let snapshot = null;
  let savedText = "";
  let saving = false;
  let loading = false;
  let loadFailed = false;
  let blockedMessage = "";
  let requestVersion = 0;
  const form = $("commandPermissionForm");
  const editor = $("commandPermissionEditor");
  const dirty = () => editor.value !== savedText;

  const message = (text, ok) => {
    if (blockedMessage) {
      text = blockedMessage;
      ok = false;
    }
    note("commandPermissionsMessage", text, ok);
    $("commandPermissionsMessage").setAttribute("role", ok ? "status" : "alert");
  };

  const updateControls = () => {
    $("commandPermissionSave").disabled =
      saving || !snapshot || !!blockedMessage || !dirty();
    $("commandPermissionFormat").disabled = !snapshot;
    $("commandPermissionsRefresh").disabled = saving || loading;
    $("commandPermissionsRefresh").textContent = dirty()
      ? "Discard draft and reload"
      : "Reload saved";
    $("commandPermissionsDraft").textContent = dirty() ? "Unsaved changes." : "";
    form.setAttribute("aria-busy", String(saving || loading));
    editor.readOnly = !snapshot;
    let entries = snapshot?.entries ?? [];
    try {
      const parsed = JSON.parse(editor.value);
      if (Array.isArray(parsed)) entries = parsed;
    } catch {
      // Keep the legacy warning visible while an incomplete draft is being edited.
    }
    $("commandPermissionsLegacy").hidden = !entries.some(
      (entry) => entry && Object.hasOwn(entry, "legacyKey"),
    );
  };

  const parseEditor = () => {
    let entries;
    try {
      entries = JSON.parse(editor.value);
    } catch (error) {
      throw new Error(
        "Invalid JSON: " +
          error.message +
          " Use double quotes, escape Windows backslashes as \\\\, and remove trailing commas.",
      );
    }
    if (!Array.isArray(entries)) {
      throw new Error(
        "Use a JSON array of command/path objects, or [] to remove all entries.",
      );
    }
    entries.forEach((entry, index) => {
      const fail = (text) => {
        throw new Error(`Entry ${index + 1}: ${text}`);
      };
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        fail("use a command/path object.");
      }
      const legacy = Object.hasOwn(entry, "legacyKey");
      const allowed = legacy
        ? ["legacyKey", "path", "hostId"]
        : ["command", "path", "match", "hostId"];
      if (Object.keys(entry).some((key) => !allowed.includes(key))) {
        fail(`only ${allowed.join(", ")} fields are supported.`);
      }
      for (const key of [legacy ? "legacyKey" : "command", "path"]) {
        if (typeof entry[key] !== "string" || !entry[key].trim()) {
          fail(`${key} must be a non-empty string.`);
        }
      }
      if (
        Object.hasOwn(entry, "hostId") &&
        (typeof entry.hostId !== "string" || !entry.hostId.trim())
      ) {
        fail("hostId must be a non-empty string, or omit it for the current Host.");
      }
      if (
        Object.hasOwn(entry, "match") &&
        !["command", "exact", "pattern"].includes(entry.match)
      ) {
        fail('match must be "command", "exact", or "pattern", or omitted.');
      }
      if (
        legacy &&
        !snapshot.entries.some(
          (saved) =>
            saved.legacyKey === entry.legacyKey &&
            saved.path === entry.path &&
            saved.hostId === entry.hostId,
        )
      ) {
        fail(
          "legacy entries are read-only authority references. Keep the saved row unchanged or delete it.",
        );
      }
    });
    return entries;
  };

  const adopt = (data, replaceText = true) => {
    snapshot = data;
    savedText = formatEntries(data.entries);
    if (replaceText) {
      editor.value = savedText;
      editor.removeAttribute("aria-invalid");
    }
  };

  const load = async ({ manual = false } = {}) => {
    if (saving || loading || (blockedMessage && !manual)) return;
    const version = ++requestVersion;
    const textAtLoad = editor.value;
    loading = true;
    updateControls();
    try {
      const data = await requestPermissions();
      if (version !== requestVersion) return;
      // A whole-document draft keeps the version it was based on, even during reload.
      if ((!manual && dirty()) || editor.value !== textAtLoad) {
        if (snapshot && snapshot.version !== data.version) {
          blockedMessage = conflictMessage;
          message("", false);
        } else if (manual) {
          message("Newer edits were kept. Reload again to discard them.", true);
        }
      } else {
        if (manual || snapshot?.version !== data.version) adopt(data);
        blockedMessage = "";
      }
      if (loadFailed || (manual && editor.value === savedText)) message("", true);
      loadFailed = false;
    } catch (error) {
      if (version !== requestVersion) return;
      loadFailed = true;
      if (error.status === 503) blockedMessage = error.message;
      if (!snapshot) editor.placeholder = "Saved allowlist unavailable.";
      message("Could not load allowlist: " + error.message, false);
    } finally {
      if (version === requestVersion) {
        loading = false;
        updateControls();
      }
    }
  };

  const save = async () => {
    if (saving || !snapshot || blockedMessage || !dirty()) return;
    loadFailed = false;
    let entries;
    try {
      entries = parseEditor();
    } catch (error) {
      editor.setAttribute("aria-invalid", "true");
      message(error.message, false);
      return;
    }
    const submittedText = editor.value;
    saving = true;
    // Ignore any poll started before this write, including its late errors.
    ++requestVersion;
    loading = false;
    editor.removeAttribute("aria-invalid");
    updateControls();
    message("Saving allowlist…", true);
    try {
      const data = await requestPermissions({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: snapshot.version, entries }),
      });
      const unchanged = editor.value === submittedText;
      adopt(data, unchanged);
      message(
        unchanged ? "Allowlist saved." : "Allowlist saved. Newer edits are not saved.",
        true,
      );
    } catch (error) {
      if (error.status === 409 || error.status === 503) blockedMessage = error.message;
      message("Could not save allowlist: " + error.message, false);
    } finally {
      saving = false;
      updateControls();
    }
  };

  editor.addEventListener("input", () => {
    editor.removeAttribute("aria-invalid");
    updateControls();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void save();
  });
  $("commandPermissionFormat").addEventListener("click", () => {
    if (!snapshot) return;
    loadFailed = false;
    try {
      editor.value = formatEntries(parseEditor());
      editor.removeAttribute("aria-invalid");
      message("JSON formatted. Nothing was saved.", true);
      updateControls();
    } catch (error) {
      editor.setAttribute("aria-invalid", "true");
      message(error.message, false);
    }
  });
  $("commandPermissionsRefresh").addEventListener(
    "click",
    () => void load({ manual: true }),
  );
  void load();
  setInterval(() => void load(), 5000);
};
