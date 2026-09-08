import type { SettingsTab } from "../components/SettingsPanel";

export const TOUR_STORAGE_KEY = "fleet.setup-tour.v1";

export type TourStep = {
  id: string;
  title: string;
  phase: "Host" | "Machine" | "Project" | "Work";
  view: "session" | "settings" | "orchestrator";
  settingsTab?: SettingsTab;
  targets: readonly string[];
  paragraphs: readonly string[];
  action?: "new-session";
  position?: "below" | "after";
  align?: "start" | "end";
};

export const tourSteps: readonly TourStep[] = [
  {
    id: "welcome",
    title: "Your Host is ready",
    phase: "Host",
    view: "session",
    targets: ['[data-tour="fleet-brand"]', '[data-tour="fleet-header"]'],
    paragraphs: [
      "You have claimed this Host and are signed in. Next, give it a machine to work on, choose a project directory, and start a session.",
      "Follow along now or look around first. This walkthrough changes no settings and starts no agents for you.",
    ],
  },
  {
    id: "tunnel",
    title: "Make the Host reachable",
    phase: "Host",
    view: "settings",
    settingsTab: "tunnel",
    targets: ['[data-tour="settings-tunnel"]'],
    paragraphs: [
      "A node on another machine needs a URL that reaches this Host. Dev Tunnels is the recommended private option.",
      "Install devtunnel and run devtunnel user login on the Host, then enable Dev Tunnels here. The setup button beside each provider explains its requirements. You can leave tunneling off for a local-only setup.",
    ],
  },
  {
    id: "node",
    title: "Connect a machine",
    phase: "Machine",
    view: "settings",
    settingsTab: "nodes",
    targets: ['[data-tour="connect-node"]', '[data-tour="settings-nodes"]'],
    align: "end",
    paragraphs: [
      "Install Node.js and sign in to Copilot CLI on the machine that will run your agents. That machine is a Node; it can also be your Host.",
      "Generate a connect command here, then copy and run it on the Node. For a private Dev Tunnel, sign that machine into devtunnel too. Wait for the Node to appear online. Each command is for one machine and expires after 15 minutes.",
    ],
  },
  {
    id: "workspace",
    title: "Name your project",
    phase: "Project",
    view: "settings",
    settingsTab: "workspaces",
    targets: ['[data-tour="create-workspace"]', '[data-tour="settings-workspaces"]'],
    position: "after",
    paragraphs: [
      "Create a workspace with a name you will recognize, such as checkout-service. A workspace groups work on the same logical project.",
      "It does not clone a repository or create a directory. Prepare the checkout on the Node first; the next step tells Fleet where it lives.",
    ],
  },
  {
    id: "placement",
    title: "Point Fleet at the real directory",
    phase: "Project",
    view: "settings",
    settingsTab: "workspaces",
    targets: ['[data-tour="add-placement"]', '[data-tour="settings-workspaces"]'],
    position: "after",
    paragraphs: [
      "A placement connects one workspace to one Node and an absolute directory on that Node. Pick your workspace and machine, then enter a path such as C:\\code\\checkout-service or /srv/checkout-service.",
      "The path must already exist on the Node, not just on the Host. Add more placements if the project has checkouts on other machines. Chats is available for work that does not need a project checkout.",
    ],
  },
  {
    id: "session",
    title: "Start your first session",
    phase: "Work",
    view: "session",
    targets: ['[data-tour="new-session"]', '[data-tour="fleet-header"]'],
    action: "new-session",
    paragraphs: [
      "Choose New session, select an online placement, and give the agent a name and a first prompt. Try: Explain this project's structure before changing anything.",
      "The Node must be online and have room for another session. Once it starts, use the conversation to send prompts, attach files or images, and discover slash commands and session pickers.",
    ],
  },
  {
    id: "permissions",
    title: "Stay in control of the work",
    phase: "Work",
    view: "settings",
    settingsTab: "general",
    targets: ['[data-tour="session-defaults"]', '[data-tour="settings-general"]'],
    paragraphs: [
      "Keep YOLO off while you get familiar with Fleet. When an agent needs permission, its conversation waits for your Allow once or Deny decision.",
      "YOLO allows tools, paths, and URLs without asking. These defaults apply to new sessions; they do not change an agent that is already running. You can stop a session or resume a saved conversation when needed.",
    ],
  },
  {
    id: "orchestrator",
    title: "Let a lead coordinate the agents",
    phase: "Work",
    view: "orchestrator",
    targets: [
      '[data-tour="start-orchestrator"]',
      '[data-tour="orchestrator-navigation"]',
      '[data-tour="fleet-header"]',
    ],
    paragraphs: [
      "Once an online Node has a placement, choose Start orchestrator. It opens a lead conversation: describe your goal there, or create a task with New task.",
      "The lead delegates work to agent sessions on your machines and brings their results back. Start with a small, bounded task and say what a successful result should look like.",
    ],
  },
  {
    id: "review",
    title: "Follow tasks through to review",
    phase: "Work",
    view: "orchestrator",
    targets: ['[data-tour="view-controls"]', '[data-tour="fleet-header"]'],
    paragraphs: [
      "After starting a lead, use Stages, List, or Dependency to follow tasks and open a worker's conversation when you need detail. Amber means something needs your attention.",
      "Review the result when a task is handed back. Approve it or request changes instead of treating an agent's last message as the final decision. Finished tasks can be archived; conversations and tasks have separate stop and resume controls.",
    ],
  },
  {
    id: "features",
    title: "Know where to look next",
    phase: "Work",
    view: "settings",
    settingsTab: "general",
    targets: ['[data-tour="tour-help"]', '[data-tour="settings-general"]'],
    paragraphs: [
      "General holds defaults and data backups. Security holds administrator accounts and portable backups. Nodes handles machine updates; Diagnostics shows Host warnings and errors.",
      "The notification bell keeps activity and failures together, and the session views help you monitor several agents. The README has the full setup and feature guide.",
      "Finish closes this walkthrough, not your setup. You can replay it here with Take the tour whenever you need a reminder.",
    ],
  },
];

export function markFirstClaimTour(): void {
  const url = new URL(window.location.href);
  url.searchParams.set("welcome", "1");
  window.history.replaceState(window.history.state, "", url);
}

export function consumeFirstClaimTour(): void {
  const url = new URL(window.location.href);
  if (url.searchParams.get("welcome") !== "1") return;
  url.searchParams.delete("welcome");
  window.history.replaceState(window.history.state, "", url);
}

export function readTourProgress(): TourStep | undefined {
  if (new URLSearchParams(window.location.search).get("welcome") === "1") {
    return tourSteps[0];
  }
  try {
    const id = sessionStorage.getItem(TOUR_STORAGE_KEY);
    return tourSteps.find((step) => step.id === id);
  } catch (error) {
    console.warn("Could not read setup tour progress in this browser.", error);
    return undefined;
  }
}

export function saveTourProgress(step?: TourStep): void {
  try {
    if (step) sessionStorage.setItem(TOUR_STORAGE_KEY, step.id);
    else sessionStorage.removeItem(TOUR_STORAGE_KEY);
  } catch (error) {
    console.warn("Could not remember setup tour progress in this browser.", error);
  }
}
