import { useState, type KeyboardEvent } from "react";
import { createRoot } from "react-dom/client";
import {
  Button,
  FluentProvider,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { Dismiss16Regular, Sparkle16Filled } from "@fluentui/react-icons";
import { fleetDarkTheme } from "../src/theme";

const GUIDE_DISMISSED_KEY = "fleet-demo.guide-dismissed";

type GuideStep = { title: string; detail: string };

const GUIDE_STEPS: readonly GuideStep[] = [
  {
    title: "Watch the fleet",
    detail:
      "Agents on three machines stream their work live. Use the grid icon in the top bar for the monitor wall.",
  },
  {
    title: "Answer a permission",
    detail:
      "“Migrate store to node:sqlite” is waiting for approval. Open it and choose Allow or Deny.",
  },
  {
    title: "Start a session",
    detail:
      "Use New session, pick a project and machine, and type a prompt. Slash commands such as /usage work too.",
  },
  {
    title: "Delegate to the Orchestrator",
    detail:
      "Open the Orchestrator, create a task, and watch it plan, dispatch parallel workers, and hand back for review.",
  },
  {
    title: "Sign off on work",
    detail:
      "“Cut CI time under 10 minutes” is awaiting your review. Approve it or send it back with a note.",
  },
  {
    title: "Explore the rest",
    detail:
      "Usage reports, Nodes, Workspaces, Remote access, and MCP settings are all clickable.",
  },
];

const useStyles = makeStyles({
  pill: {
    position: "fixed",
    bottom: "96px",
    right: "16px",
    zIndex: 1000000,
    display: "flex",
    alignItems: "center",
    gap: "6px",
    paddingBlock: "6px",
    paddingInline: "12px",
    borderRadius: tokens.borderRadiusCircular,
    border: `1px solid ${tokens.colorBrandStroke1}`,
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground1,
    boxShadow: tokens.shadow16,
    cursor: "pointer",
    fontSize: tokens.fontSizeBase200,
    ":focus-visible": {
      outline: `2px solid ${tokens.colorBrandStroke1}`,
      outlineOffset: "2px",
    },
  },
  card: {
    position: "fixed",
    bottom: "96px",
    right: "16px",
    zIndex: 1000000,
    width: "min(360px, calc(100vw - 32px))",
    maxHeight: "calc(100vh - 160px)",
    overflowY: "auto",
    padding: "16px",
    borderRadius: tokens.borderRadiusXLarge,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground1,
    boxShadow: tokens.shadow28,
    display: "flex",
    flexDirection: "column",
    gap: "10px",
  },
  header: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: "8px",
  },
  title: {
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
  },
  intro: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
  },
  steps: {
    margin: 0,
    paddingInlineStart: "20px",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  stepTitle: {
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase200,
  },
  stepDetail: {
    display: "block",
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
  },
  footer: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase100,
  },
});

const readDismissed = (): boolean => {
  try {
    return sessionStorage.getItem(GUIDE_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
};

const saveDismissed = (dismissed: boolean): void => {
  try {
    if (dismissed) sessionStorage.setItem(GUIDE_DISMISSED_KEY, "1");
    else sessionStorage.removeItem(GUIDE_DISMISSED_KEY);
  } catch {
    // Without storage the guide simply reopens on reload.
  }
};

/** A corner guide that says this is a simulation and suggests what to try. */
const DemoGuide = () => {
  const styles = useStyles();
  const [collapsed, setCollapsed] = useState(readDismissed);

  const handleCollapse = () => {
    saveDismissed(true);
    setCollapsed(true);
  };

  const handleExpand = () => {
    saveDismissed(false);
    setCollapsed(false);
  };

  const handlePillKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    handleExpand();
  };

  const handleCardKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    handleCollapse();
  };

  if (collapsed) {
    return (
      <div
        className={styles.pill}
        role="button"
        tabIndex={0}
        aria-label="Open the demo guide"
        onClick={handleExpand}
        onKeyDown={handlePillKeyDown}
      >
        <Sparkle16Filled aria-hidden />
        Interactive demo · What to try
      </div>
    );
  }

  return (
    <aside
      className={styles.card}
      aria-label="Copilot Fleet demo guide"
      onKeyDown={handleCardKeyDown}
    >
      <div className={styles.header}>
        <Text className={styles.title}>Copilot Fleet · interactive demo</Text>
        <Button
          appearance="subtle"
          size="small"
          icon={<Dismiss16Regular />}
          aria-label="Minimise the demo guide"
          onClick={handleCollapse}
        />
      </div>
      <Text className={styles.intro}>
        This is the real Fleet UI running against a simulated Host in your browser. No
        agents, machines, or accounts are involved, so click anything.
      </Text>
      <ol className={styles.steps}>
        {GUIDE_STEPS.map((step) => (
          <li key={step.title}>
            <Text className={styles.stepTitle}>{step.title}</Text>
            <Text className={styles.stepDetail}>{step.detail}</Text>
          </li>
        ))}
      </ol>
      <Text className={styles.footer}>
        Reload the page to reset the fleet. Agent output is scripted.
      </Text>
    </aside>
  );
};

export const mountDemoGuide = (): void => {
  const container = document.createElement("div");
  container.id = "fleet-demo-guide";
  document.body.appendChild(container);
  createRoot(container).render(
    <FluentProvider theme={fleetDarkTheme} style={{ background: "transparent" }}>
      <DemoGuide />
    </FluentProvider>,
  );
};
