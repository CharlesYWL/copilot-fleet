const { resolve, sep } = require("node:path");
const { fileURLToPath } = require("node:url");
const sqlite = require("node:sqlite");
const { syncBuiltinESMExports } = require("node:module");

const root = resolve(__dirname, "..");
const allowed = [".dri-review-work", ".dri-test-work"].map(
  (directory) => resolve(root, directory).toLowerCase() + sep,
);
const legacyFixtures =
  resolve(root, "apps", "host", "data", "test-scratch").toLowerCase() + sep;
const DatabaseSync = sqlite.DatabaseSync;

// Validation must fail before opening the operator's default Host store.
sqlite.DatabaseSync = class GuardedDatabaseSync extends DatabaseSync {
  constructor(filename, ...options) {
    if (filename !== ":memory:") {
      const value = filename instanceof URL ? fileURLToPath(filename) : String(filename);
      const path = resolve(value).toLowerCase();
      const legacyParts = path.startsWith(legacyFixtures)
        ? path.slice(legacyFixtures.length).split(sep)
        : [];
      const legacyTest =
        legacyParts.length === 2 &&
        /^legacy-[a-z0-9]+$/.test(legacyParts[0]) &&
        legacyParts[1] === "fleet.db";
      if (!legacyTest && !allowed.some((directory) => path.startsWith(directory))) {
        throw new Error("Blocked non-isolated SQLite open during DRI validation");
      }
    }
    super(filename, ...options);
  }
};
syncBuiltinESMExports();
