import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Button,
  TeachingPopover,
  TeachingPopoverBody,
  TeachingPopoverHeader,
  TeachingPopoverSurface,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
  useId,
} from "@fluentui/react-components";
import { BookOpen20Regular } from "@fluentui/react-icons";
import { tourSteps, type TourStep } from "../lib/onboarding";

const phases = ["Host", "Machine", "Project", "Work"] as const;

const useStyles = makeStyles({
  surface: {
    boxSizing: "border-box",
    minWidth: 0,
    width: "min(380px, calc(100vw - 24px))",
    maxHeight: "calc(100dvh - 32px)",
    overflowY: "auto",
    border: `1px solid ${tokens.colorBrandStroke1}`,
    borderTopWidth: "3px",
    borderRadius: tokens.borderRadiusXLarge,
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground1,
    boxShadow: tokens.shadow64,
    "@media (prefers-reduced-motion: reduce)": {
      animationDuration: "0ms",
      transitionDuration: "0ms",
    },
  },
  header: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  body: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
  },
  journey: {
    display: "grid",
    gridTemplateColumns: "repeat(4, 1fr)",
    gap: tokens.spacingHorizontalXS,
    marginBottom: tokens.spacingVerticalS,
  },
  phase: {
    paddingBlock: tokens.spacingVerticalXS,
    borderBottom: `2px solid ${tokens.colorNeutralStroke1}`,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  currentPhase: {
    borderBottomColor: tokens.colorBrandStroke1,
    color: tokens.colorBrandForeground1,
    fontWeight: tokens.fontWeightSemibold,
  },
  title: {
    margin: 0,
    outlineStyle: "none",
    fontSize: tokens.fontSizeBase500,
    lineHeight: tokens.lineHeightBase500,
    fontWeight: tokens.fontWeightSemibold,
  },
  paragraph: {
    margin: 0,
    color: tokens.colorNeutralForeground2,
    lineHeight: tokens.lineHeightBase300,
  },
  action: { alignSelf: "flex-start" },
  footer: {
    display: "flex",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalS,
    marginTop: tokens.spacingVerticalL,
  },
  paused: {
    position: "fixed",
    insetInlineEnd: "16px",
    bottom: "16px",
    zIndex: 30,
    display: "flex",
    gap: tokens.spacingHorizontalXS,
    padding: tokens.spacingHorizontalXS,
    border: `1px solid ${tokens.colorBrandStroke1}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground3,
    boxShadow: tokens.shadow16,
  },
});

function isVisible(element: HTMLElement): boolean {
  if (element.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
  for (
    let current: HTMLElement | null = element;
    current;
    current = current.parentElement
  ) {
    const style = getComputedStyle(current);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}

function useTourAnchor(selectors: readonly string[]) {
  const [anchor, setAnchor] = useState<{
    target: HTMLElement | undefined;
    modalOpen: boolean;
    compact: boolean;
  }>({ target: undefined, modalOpen: false, compact: window.innerWidth < 900 });

  useLayoutEffect(() => {
    let frame: number | undefined;
    const measure = () => {
      frame = undefined;
      let target: HTMLElement | undefined;
      for (const selector of selectors) {
        target = [...document.querySelectorAll<HTMLElement>(selector)].find(isVisible);
        if (target) break;
      }
      const modalOpen = [
        ...document.querySelectorAll<HTMLElement>(
          '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]',
        ),
      ].some(isVisible);
      const compact = window.innerWidth < 900;
      setAnchor((current) =>
        current.target === target &&
        current.modalOpen === modalOpen &&
        current.compact === compact
          ? current
          : { target, modalOpen, compact },
      );
    };
    const schedule = () => {
      frame ??= requestAnimationFrame(measure);
    };

    // Settings load lazily, and their dialogs live in portals outside the App.
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["hidden", "aria-hidden", "aria-modal"],
    });
    window.addEventListener("resize", schedule);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [selectors]);

  return anchor;
}

type OnboardingTourProps = {
  step: TourStep;
  index: number;
  onPage: boolean;
  blocked: boolean;
  paused: boolean;
  onNext: () => void;
  onBack: () => void;
  onDismiss: () => void;
  onResume: () => void;
  onPause: () => void;
  onNewSession: () => void;
};

export function OnboardingTour({
  step,
  index,
  onPage,
  blocked,
  paused,
  onNext,
  onBack,
  onDismiss,
  onResume,
  onPause,
  onNewSession,
}: OnboardingTourProps) {
  const styles = useStyles();
  const titleId = useId("tour-title");
  const bodyId = useId("tour-body");
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [returnFocus] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const { target, modalOpen, compact } = useTourAnchor(step.targets);
  const obscured = blocked || modalOpen;
  const visible = Boolean(onPage && target && !obscured && !paused);

  useEffect(() => {
    if (!visible || !target) return;
    target.setAttribute("data-tour-highlighted", "true");
    target.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: "auto" });
    return () => target.removeAttribute("data-tour-highlighted");
  }, [target, visible]);

  useEffect(() => {
    if (visible) titleRef.current?.focus({ preventScroll: true });
  }, [step.id, visible]);

  const close = () => {
    const focusTarget =
      returnFocus?.isConnected && returnFocus.tabIndex >= 0 && isVisible(returnFocus)
        ? returnFocus
        : target && target.tabIndex >= 0
          ? target
          : document.querySelector<HTMLElement>('[data-tour="fleet-header"]');
    focusTarget?.focus({ preventScroll: true });
    onDismiss();
  };

  if (obscured) return null;
  if (!visible || !target) {
    return (
      <div className={styles.paused} role="group" aria-label="Setup tour paused">
        <Button appearance="primary" icon={<BookOpen20Regular />} onClick={onResume}>
          Resume tour
        </Button>
        <Button appearance="subtle" onClick={close}>
          Skip tour
        </Button>
      </div>
    );
  }

  const last = index === tourSteps.length - 1;
  return (
    <TeachingPopover
      open
      trapFocus={false}
      unstable_disableAutoFocus
      positioning={{
        target,
        position: compact ? "below" : (step.position ?? "below"),
        align: compact ? "start" : (step.align ?? "start"),
        offset: 12,
        autoSize: "height",
        overflowBoundary: "window",
        flipBoundary: "window",
        overflowBoundaryPadding: 12,
        strategy: "fixed",
      }}
      onOpenChange={(event, data) => {
        if (!data.open && "key" in event && event.key === "Escape") close();
      }}
    >
      <TeachingPopoverSurface
        className={styles.surface}
        role="dialog"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        aria-modal={false}
      >
        <TeachingPopoverHeader
          className={styles.header}
          icon={<BookOpen20Regular />}
          dismissButton={{ "aria-label": "Skip tour", onClick: close }}
        >
          Setup tour / {index + 1} of {tourSteps.length}
        </TeachingPopoverHeader>
        <TeachingPopoverBody className={styles.body}>
          <div className={styles.journey} aria-label={`Current stage: ${step.phase}`}>
            {phases.map((phase) => (
              <span
                key={phase}
                className={mergeClasses(
                  styles.phase,
                  phase === step.phase && styles.currentPhase,
                )}
                aria-current={phase === step.phase ? "step" : undefined}
              >
                {phase}
              </span>
            ))}
          </div>
          <h2 ref={titleRef} id={titleId} tabIndex={-1} className={styles.title}>
            {step.title}
          </h2>
          <div id={bodyId} className={styles.body}>
            {step.paragraphs.map((paragraph) => (
              <Text as="p" key={paragraph} className={styles.paragraph}>
                {paragraph}
              </Text>
            ))}
          </div>
          {step.action === "new-session" ? (
            <Button
              appearance="secondary"
              className={styles.action}
              onClick={onNewSession}
            >
              Open New session
            </Button>
          ) : index > 0 && !last ? (
            <Button appearance="secondary" className={styles.action} onClick={onPause}>
              Let me do this step
            </Button>
          ) : null}
        </TeachingPopoverBody>
        <div className={styles.footer}>
          <Button appearance="subtle" disabled={index === 0} onClick={onBack}>
            Back
          </Button>
          <Button appearance="primary" onClick={last ? close : onNext}>
            {last ? "Finish tour" : index === 0 ? "Show me around" : "Next"}
          </Button>
        </div>
      </TeachingPopoverSurface>
    </TeachingPopover>
  );
}
