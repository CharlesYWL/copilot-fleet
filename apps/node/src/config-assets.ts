import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { packageRoot } from "@fleet/protocol/runtime";

export type ConfigAsset = { body: string; contentType: string };

/**
 * The config page, served from `public/` instead of a 400-line template string.
 *
 * The files are named individually rather than joined from the request
 * path: this listener answers a browser, and there is no reason for it to be
 * able to read any other file on the machine.
 */
const ASSETS: Record<string, { file: string; contentType: string }> = {
  "/": { file: "index.html", contentType: "text/html; charset=utf-8" },
  "/config.css": { file: "config.css", contentType: "text/css; charset=utf-8" },
  "/config.js": {
    file: "config.js",
    contentType: "text/javascript; charset=utf-8",
  },
  "/diagnostics.js": {
    file: "diagnostics.js",
    contentType: "text/javascript; charset=utf-8",
  },
  "/fleet-workspaces.js": {
    file: "fleet-workspaces.js",
    contentType: "text/javascript; charset=utf-8",
  },
  "/node-settings.js": {
    file: "node-settings.js",
    contentType: "text/javascript; charset=utf-8",
  },
  "/sessions.js": {
    file: "sessions.js",
    contentType: "text/javascript; charset=utf-8",
  },
  "/ui.js": {
    file: "ui.js",
    contentType: "text/javascript; charset=utf-8",
  },
};

const cache = new Map<string, ConfigAsset>();

function publicDirectory(): string {
  return join(packageRoot(dirname(fileURLToPath(import.meta.url))), "public");
}

/** The asset for a request path, or undefined when the path is not one of ours. */
export function configAsset(pathname: string): ConfigAsset | undefined {
  const entry = ASSETS[pathname];
  if (!entry) return undefined;
  const cached = cache.get(pathname);
  if (cached) return cached;
  const asset: ConfigAsset = {
    body: readFileSync(join(publicDirectory(), entry.file), "utf8"),
    contentType: entry.contentType,
  };
  cache.set(pathname, asset);
  return asset;
}
