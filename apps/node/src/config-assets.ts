import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { packageRoot } from "@fleet/protocol/runtime";

export type ConfigAsset = { body: string | Buffer; contentType: string };

/**
 * The config page, served from `public/` instead of a 400-line template string.
 *
 * The files are named individually rather than joined from the request
 * path: this listener answers a browser, and there is no reason for it to be
 * able to read any other file on the machine.
 */
const ASSETS: Record<string, { file: string; contentType: string }> = {
  "/": { file: "index.html", contentType: "text/html; charset=utf-8" },
  "/favicon.svg": { file: "favicon.svg", contentType: "image/svg+xml" },
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
  "/command-permissions.js": {
    file: "command-permissions.js",
    contentType: "text/javascript; charset=utf-8",
  },
  "/sessions.js": {
    file: "sessions.js",
    contentType: "text/javascript; charset=utf-8",
  },
  "/fleet-sessions.js": {
    file: "fleet-sessions.js",
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

function consoleDirectory(): string {
  return join(packageRoot(dirname(fileURLToPath(import.meta.url))), "dist", "ui");
}

const GENERATED_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

type GeneratedAsset = { file: string; contentType: string };
const generated = new Map<string, Map<string, GeneratedAsset>>();

function boundedFile(directory: string, file: string): string {
  const full = realpathSync(join(directory, file));
  const local = relative(realpathSync(directory), full);
  if (
    isAbsolute(local) ||
    local === ".." ||
    local.startsWith(`..${sep}`) ||
    !statSync(full).isFile()
  ) {
    throw new Error("Session console asset escapes its build directory");
  }
  return full;
}

/** Only the entry's manifest-reachable build files become public URLs. */
function generatedAssets(
  directory: string,
  expectedRevision?: string,
): Map<string, GeneratedAsset> {
  const manifestFile = boundedFile(directory, ".vite/manifest.json");
  const manifest: unknown = JSON.parse(readFileSync(manifestFile, "utf8"));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Invalid session console manifest");
  }
  const records = manifest as Record<string, unknown>;
  const assets = new Map<string, GeneratedAsset>();
  const visited = new Set<string>();
  const add = (file: unknown) => {
    if (
      typeof file !== "string" ||
      !/^assets\/[A-Za-z0-9_./-]+$/.test(file) ||
      file.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error("Unsafe session console manifest asset");
    }
    const contentType = GENERATED_TYPES[extname(file)];
    if (!contentType) throw new Error("Unsupported session console asset type");
    assets.set(`/session-console/${file}`, {
      file: boundedFile(directory, file),
      contentType,
    });
  };
  const visit = (key: string) => {
    if (visited.has(key)) return;
    visited.add(key);
    const record = records[key];
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error("Missing session console manifest entry");
    }
    const entry = record as Record<string, unknown>;
    if (key === "index.html" && entry.isEntry !== true)
      throw new Error("Missing session console entrypoint");
    if (
      key === "index.html" &&
      expectedRevision !== undefined &&
      entry.revision !== expectedRevision
    ) {
      throw new Error(
        `Session console build revision mismatch: expected ${expectedRevision || "(unknown)"}, found ${
          typeof entry.revision === "string" ? entry.revision || "(unknown)" : "(missing)"
        }`,
      );
    }
    add(entry.file);
    for (const field of ["css", "assets"]) {
      const values = entry[field] ?? [];
      if (!Array.isArray(values)) throw new Error("Invalid session console asset list");
      values.forEach(add);
    }
    for (const field of ["imports", "dynamicImports"]) {
      const values = entry[field] ?? [];
      if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
        throw new Error("Invalid session console import list");
      }
      values.forEach((value: string) => visit(value));
    }
  };
  visit("index.html");
  const html = boundedFile(directory, "index.html");
  const body = readFileSync(html, "utf8");
  const references = [...body.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map(
    (match) => match[1]!,
  );
  const entry = records["index.html"] as { file: string };
  if (
    !references.includes(`/session-console/${entry.file}`) ||
    references.some((path) => !assets.has(path))
  ) {
    throw new Error("Session console HTML does not match its manifest");
  }
  assets.set("/session-console/index.html", {
    file: html,
    contentType: "text/html; charset=utf-8",
  });
  return assets;
}

/** Pass the running/target gitRevision() to reject stale UI builds during admission. */
export function validateSessionConsoleAssets(
  directory = consoleDirectory(),
  expectedRevision?: string,
): { ok: true } | { ok: false; error: string } {
  try {
    generatedAssets(directory, expectedRevision);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

const unavailable: ConfigAsset = {
  contentType: "text/html; charset=utf-8",
  body: '<!doctype html><html lang="en"><meta charset="utf-8"><title>Session console unavailable</title><body style="background:#080c14;color:#eee;font-family:system-ui;padding:24px"><h2>Session console bundle unavailable</h2><p>Build or update this Node to enable chat. Settings, workspaces, diagnostics, and native session discovery remain available.</p></body></html>',
};

/** The asset for a request path, or undefined when the path is not one of ours. */
export function configAsset(
  pathname: string,
  uiDirectory = consoleDirectory(),
): ConfigAsset | undefined {
  if (pathname.startsWith("/session-console/")) {
    try {
      const key = resolve(uiDirectory);
      let files = generated.get(key);
      if (!files) {
        files = generatedAssets(key);
        generated.set(key, files);
      }
      const entry = files.get(pathname);
      if (!entry) return undefined;
      // Resolve again so a changed symlink cannot turn the allowlist into a file proxy.
      const file = boundedFile(key, relative(key, entry.file));
      return {
        body: /^(?:text\/|image\/svg)/.test(entry.contentType)
          ? readFileSync(file, "utf8")
          : readFileSync(file),
        contentType: entry.contentType,
      };
    } catch {
      return pathname === "/session-console/index.html" ? unavailable : undefined;
    }
  }
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
