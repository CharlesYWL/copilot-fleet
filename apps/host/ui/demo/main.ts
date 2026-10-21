/**
 * Entry point for the playable showcase build.
 *
 * Installs the in-browser Host first, so the very first request the app makes
 * is already answered by it, then loads the unmodified Fleet UI.
 */
import { installDemoHost } from "./mock-host";
import { mountDemoGuide } from "./DemoGuide";

installDemoHost();

void import("../src/main").then(() => mountDemoGuide());
