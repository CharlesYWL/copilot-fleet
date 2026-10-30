import {
  nodeConnectionLabels,
  tunnelProviders,
  type FleetNode,
  type TunnelProvider,
  type Workspace,
} from "@fleet/protocol";
import { matchesAllTerms, searchTerms } from "./search-text";

/**
 * What the Settings search can find, and where each result lives on the page.
 *
 * Every entry names an element by its `data-setting-id`, which is the entry's
 * own `id`; choosing a result switches to the entry's tab and scrolls that
 * element into view. A test renders every Settings page and checks each static
 * entry still has its element, so renaming or removing a card cannot quietly
 * leave a result that goes nowhere.
 */

export type SettingsTab =
  | "general"
  | "orchestrator"
  | "security"
  | "tunnel"
  | "nodes"
  | "workspaces"
  | "diagnostics";

/** The Settings sections, in tab order. The tab strip renders from this list. */
export const settingsSections: readonly { value: SettingsTab; label: string }[] = [
  { value: "general", label: "General" },
  { value: "orchestrator", label: "Orchestrator" },
  { value: "security", label: "Security" },
  { value: "tunnel", label: "Tunnel" },
  { value: "nodes", label: "Nodes" },
  { value: "workspaces", label: "Workspaces" },
  { value: "diagnostics", label: "Diagnostics" },
];

export const sectionLabel = (tab: SettingsTab): string =>
  settingsSections.find((section) => section.value === tab)?.label ?? tab;

/**
 * What a result is, which decides how it is ranked against others.
 *
 * `node` and `workspace` are the fleet's own items, listed by name so a
 * machine or a project can be found without knowing which tab holds it.
 */
export type SettingsSearchEntryKind = "section" | "setting" | "node" | "workspace";

export type SettingsSearchEntry = {
  /** Unique; also the `data-setting-id` of the element this result reveals. */
  id: string;
  kind: SettingsSearchEntryKind;
  tab: SettingsTab;
  /** The name shown on the card, which is what people search for first. */
  title: string;
  /** Other words it answers to: what it does, rather than what it is called. */
  keywords: readonly string[];
  /**
   * Shown only on some Hosts or in some states — see `isSettingAvailable`.
   * Everything else is always on its page, if sometimes a moment after it.
   */
  conditional?: boolean;
};

/** Keywords for each Settings page, beyond its tab label. */
const sectionKeywords: Record<SettingsTab, readonly string[]> = {
  general: ["session defaults", "defaults"],
  orchestrator: ["lead", "coordinator"],
  security: ["sign-in", "authentication"],
  tunnel: ["remote access", "public url"],
  nodes: ["machines"],
  workspaces: ["projects", "placements"],
  diagnostics: ["host runtime logs", "logs", "errors", "warnings", "troubleshooting"],
};

const setting = (
  tab: SettingsTab,
  id: string,
  title: string,
  keywords: readonly string[],
  conditional = false,
): SettingsSearchEntry => ({
  id: `${tab}.${id}`,
  kind: "setting",
  tab,
  title,
  keywords,
  ...(conditional ? { conditional } : {}),
});

/** Marks a setting that only some Hosts, or some states, show. */
const CONDITIONAL = true;

const providerKeywords: Record<TunnelProvider, readonly string[]> = {
  devtunnel: ["devtunnel", "private", "microsoft", "tunnel login"],
  cloudflare: ["cloudflared", "trycloudflare", "quick tunnel", "named tunnel"],
  tailscale: ["funnel"],
  ngrok: ["ngrok-free"],
  bore: ["plain http", "tcp relay"],
  "corp-direct": ["private network", "firewall", "ip address", "corporate", "listener"],
};

/**
 * Every setting the Settings pages can show, in page order.
 *
 * Some only appear on some Hosts — Agency mode for Microsoft staff, the Host
 * update where the Host can update itself, sign-in setup when sign-in is off —
 * and a result for one of those is withheld once its page has loaded without
 * it; see `isSettingAvailable`.
 */
export const staticSettingEntries: readonly SettingsSearchEntry[] = [
  setting("general", "managed-worktrees", "Managed worktree isolation", [
    "worktree",
    "git",
    "isolated",
    "checkout",
    "writer",
  ]),
  setting(
    "general",
    "managed-worktrees.quotas",
    "Managed retention and quotas",
    [
      "retention days",
      "maximum worktrees",
      "free-space floor",
      "disk",
      "byte budget",
      "cleanup",
    ],
    CONDITIONAL,
  ),
  setting(
    "general",
    "tour",
    "Getting started",
    ["setup tour", "walkthrough", "onboarding", "help", "guide"],
    CONDITIONAL,
  ),
  setting("general", "long-context", "Long context by default", [
    "context window",
    "long_context",
    "--context",
    "tokens",
  ]),
  setting("general", "yolo", "YOLO mode", [
    "--allow-all",
    "permissions",
    "approval",
    "unattended",
  ]),
  setting(
    "general",
    "agency",
    "Agency mode",
    ["agency copilot", "launcher", "staff"],
    CONDITIONAL,
  ),
  setting("general", "auto-resume", "Reconnect sessions automatically", [
    "auto resume",
    "reattach",
    "restart",
    "reboot",
  ]),
  setting("general", "lifecycle-notifications", "Lifecycle notifications", [
    "alerts",
    "notify",
    "finished agents",
  ]),
  setting("general", "model", "Default Copilot model", [
    "reasoning effort",
    "workers",
    "reviewers",
    "chats",
  ]),
  setting("general", "worker-routing", "Worker model routing", [
    "decision settings",
    "decision model",
    "experimental",
    "foundry",
    "typesafe",
    "profiles",
  ]),
  setting(
    "general",
    "host-update",
    "Update Host",
    ["upgrade", "pull", "build", "restart", "revision", "version"],
    CONDITIONAL,
  ),
  setting("general", "data", "Export fleet data", [
    "import",
    "backup",
    "archive",
    "restore",
    "json",
  ]),

  setting("orchestrator", "agent", "Preferred agent", [
    "hermes",
    "copilot",
    "auto",
    "profile",
    "backend",
  ]),
  setting("orchestrator", "model.copilot", "Default Copilot model", [
    "lead model",
    "reasoning effort",
  ]),
  setting("orchestrator", "model.hermes", "Default Hermes model", [
    "lead model",
    "hermes profile",
  ]),
  setting("orchestrator", "heartbeat", "Orchestrator heartbeat", [
    "schedule",
    "cron",
    "wake",
    "time zone",
    "pull requests",
  ]),

  /*
   * Security shows one of two pages: with Microsoft sign-in off, the sign-in
   * setup and a few cards; with it on, everything else. Those that belong to
   * only one of them are conditional.
   */
  setting(
    "security",
    "sign-in-setup",
    "Set up Microsoft sign-in",
    ["claim code", "entra", "enable sign-in", "microsoft account"],
    CONDITIONAL,
  ),
  setting("security", "host", "This Host", [
    "signed in as",
    "authentication mode",
    "host id",
    "fingerprint",
    "tenant",
  ]),
  setting(
    "security",
    "microsoft-config",
    "Microsoft sign-in configuration",
    ["entra", "app registration", "client id", "tenant"],
    CONDITIONAL,
  ),
  setting(
    "security",
    "password",
    "Password sign-in",
    ["operator password", "shared password"],
    CONDITIONAL,
  ),
  setting(
    "security",
    "device",
    "Device sign-in",
    ["device code", "device flow", "conditional access"],
    CONDITIONAL,
  ),
  setting(
    "security",
    "pending",
    "Waiting for approval",
    ["pending", "invitation", "approve", "reject"],
    CONDITIONAL,
  ),
  setting(
    "security",
    "administrators",
    "Administrators",
    ["admins", "invite", "add account", "remove"],
    CONDITIONAL,
  ),
  setting("security", "node-auth", "Node authentication", [
    "mutual authentication",
    "node keys",
    "shared secret",
    "legacy",
  ]),
  setting(
    "security",
    "portable-backup",
    "Move this Host",
    ["portable backup", "passphrase", "migrate", "restore"],
    CONDITIONAL,
  ),
  setting("security", "local-agent", "Local agent API", [
    "loopback",
    "port",
    "mcp",
    "scripts",
  ]),
  setting("security", "host-mcp", "Host MCP forwarding", [
    "mcp servers",
    "figma",
    "share",
  ]),
  setting(
    "security",
    "audit",
    "Security audit",
    ["audit log", "events", "history"],
    CONDITIONAL,
  ),
  setting(
    "security",
    "erase",
    "Erase auth settings",
    ["reset sign-in", "claim code", "remove administrators"],
    CONDITIONAL,
  ),

  // A Microsoft corporate Host lists only the providers its policy allows.
  ...tunnelProviders.map((provider) =>
    setting(
      "tunnel",
      `provider.${provider}`,
      nodeConnectionLabels[provider],
      providerKeywords[provider],
      CONDITIONAL,
    ),
  ),

  setting("nodes", "connect", "Connect a machine", [
    "enroll",
    "enrollment",
    "connect command",
    "add node",
    "fingerprint",
  ]),
  setting(
    "nodes",
    "update-all",
    "Update all nodes",
    ["upgrade", "stale", "behind"],
    CONDITIONAL,
  ),
  setting("nodes", "inventory", "Node inventory", [
    "capacity",
    "platform",
    "health",
    "version",
    "rename",
  ]),

  setting("workspaces", "create", "Create workspace", ["new workspace", "add project"]),
  setting("workspaces", "placement", "Add placement", [
    "path",
    "checkout",
    "directory",
    "local path",
  ]),
];

export type SettingsIndexSource = {
  nodes: readonly Pick<FleetNode, "id" | "name">[];
  workspaces: readonly Pick<Workspace, "id" | "name" | "description">[];
};

/**
 * Sections, settings, and the fleet's nodes and workspaces, in page order.
 *
 * Each section comes first, followed by what it holds; ranking falls back to
 * this order between equally good matches, so results read in the order the
 * pages do.
 */
export function buildSettingsIndex({
  nodes,
  workspaces,
}: SettingsIndexSource): SettingsSearchEntry[] {
  return settingsSections.flatMap(({ value, label }) => [
    {
      id: value,
      kind: "section",
      tab: value,
      title: label,
      keywords: sectionKeywords[value],
    },
    ...staticSettingEntries.filter((entry) => entry.tab === value),
    ...(value === "nodes"
      ? nodes.map((node): SettingsSearchEntry => ({
          id: `node:${node.id}`,
          kind: "node",
          tab: "nodes",
          title: node.name,
          keywords: [],
        }))
      : []),
    ...(value === "workspaces"
      ? workspaces.map((workspace): SettingsSearchEntry => ({
          id: `workspace:${workspace.id}`,
          kind: "workspace",
          tab: "workspaces",
          title: workspace.name,
          keywords: workspace.description ? [workspace.description] : [],
        }))
      : []),
  ]);
}

/** Enough to scroll, short enough that a one-letter query stays readable. */
const MAX_RESULTS = 50;

/**
 * How well one term matches a title, lower being better: the start of the
 * title, the start of one of its words, anywhere in it, or only in the
 * section name or keywords.
 */
function termScore(term: string, title: string, words: readonly string[]): number {
  if (title.startsWith(term)) return 0;
  if (words.some((word) => word.startsWith(term))) return 1;
  if (title.includes(term)) return 2;
  return 3;
}

/**
 * The entries a query finds, best first.
 *
 * An entry is found when every term appears in its title, its section's name
 * or its keywords — the section counts, so "security password" narrows to the
 * one page. Titles outrank keywords, a title naming the query exactly comes
 * first, a page beats a setting that ties with it, and equal matches keep the
 * index's page order.
 */
export function searchSettings(
  entries: readonly SettingsSearchEntry[],
  query: string,
): SettingsSearchEntry[] {
  const terms = searchTerms(query);
  if (terms.length === 0) return [];
  const phrase = terms.join(" ");
  return entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) =>
      matchesAllTerms([entry.title, sectionLabel(entry.tab), ...entry.keywords], terms),
    )
    .map(({ entry, index }) => {
      const title = entry.title.toLowerCase();
      const words = title.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      const exact = title === phrase ? -1 : 0;
      const score =
        exact + terms.reduce((sum, term) => sum + termScore(term, title, words), 0);
      return { entry, index, score, page: entry.kind === "section" ? 0 : 1 };
    })
    .sort((a, b) => a.score - b.score || a.page - b.page || a.index - b.index)
    .slice(0, MAX_RESULTS)
    .map(({ entry }) => entry);
}

/** The attribute that marks where a search result lands. */
export const SETTING_ANCHOR_ATTRIBUTE = "data-setting-id";
/** The attribute that marks a Settings page, once it has been opened. */
export const SETTINGS_PAGE_ATTRIBUTE = "data-settings-page";

export const settingAnchorSelector = (id: string) =>
  `[${SETTING_ANCHOR_ATTRIBUTE}="${CSS.escape(id)}"]`;

/**
 * Whether a result can still lead somewhere, judged from the pages on screen.
 *
 * Only a conditional setting can be missing for good. Pages load the first
 * time they are opened and learn what this Host offers only once they have,
 * so one is withheld only after its page has finished drawing — its heading,
 * which is the page's own anchor, is there — without it. Until then it is
 * offered, and choosing it reports the miss if there is one.
 */
export function isSettingAvailable(
  root: ParentNode,
  entry: SettingsSearchEntry,
): boolean {
  if (!entry.conditional) return true;
  const page = root.querySelector(`[${SETTINGS_PAGE_ATTRIBUTE}="${entry.tab}"]`);
  if (!page || !page.querySelector(settingAnchorSelector(entry.tab))) return true;
  return Boolean(page.querySelector(settingAnchorSelector(entry.id)));
}
