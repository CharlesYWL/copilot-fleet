/**
 * The node's local config page is served as native browser modules.
 *
 * This entry point only composes feature controllers. Each controller owns one
 * section of the page and shares the small DOM/request helpers in ui.js.
 */

import { initDiagnostics } from "./diagnostics.js";
import { initFleetWorkspaces } from "./fleet-workspaces.js";
import { initNodeSettings } from "./node-settings.js";
import { initSessions } from "./sessions.js";
import { initShell } from "./ui.js";

initShell();
const settings = initNodeSettings();
initDiagnostics({
  loadConfig: settings.load,
  renderConfig: settings.render,
});
initFleetWorkspaces();
initSessions();
