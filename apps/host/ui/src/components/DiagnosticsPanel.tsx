import { useCallback, useEffect, useRef, useState } from "react";
import {
  Button,
  Text,
  Title3,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import { ArrowClockwise20Regular } from "@fluentui/react-icons";
import { api } from "../hooks/useFleet";

/**
 * What the Host has complained about lately.
 *
 * The Host logs to the terminal it was started from. On a fleet that runs
 * unattended that is a terminal nobody is watching, and by the time something
 * has gone wrong it is often a terminal that has been closed — so the record of
 * what happened existed only where it could not be read. The operator is here.
 *
 * Only warnings and errors are kept, because the Host logs every request it
 * serves and a buffer holding those would evict the one line worth reading long
 * before anyone came looking for it.
 */

const useStyles = makeStyles({
  panel: {
    flexGrow: 1,
    overflowY: "auto",
    padding: "28px 32px",
    display: "flex",
    flexDirection: "column",
    gap: "16px",
    maxWidth: "860px",
    minHeight: 0,
  },
  caption: {
    color: tokens.colorNeutralForeground3,
  },
  head: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "16px",
  },
  /*
   * Bounded and scrollable rather than growing with the log: an unbounded block
   * pushes everything else off the screen, and the newest line — the one being
   * waited for — ends up furthest from the eye.
   */
  log: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground3,
    padding: "10px 12px",
    maxHeight: "420px",
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: "12px",
    lineHeight: "1.55",
  },
  line: {
    display: "flex",
    gap: "10px",
    alignItems: "baseline",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  at: {
    flexShrink: 0,
    color: tokens.colorNeutralForeground4,
  },
  warn: {
    color: tokens.colorPaletteYellowForeground1,
  },
  error: {
    color: tokens.colorPaletteRedForeground1,
  },
  empty: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
});

type LogEntry = { at: string; level: "info" | "warn" | "error"; message: string };

const clockTime = (at: string): string => {
  const parsed = Date.parse(at);
  return Number.isNaN(parsed)
    ? at
    : new Date(parsed).toLocaleTimeString(undefined, { hour12: false });
};

export const DiagnosticsPanel = () => {
  const styles = useStyles();
  const [entries, setEntries] = useState<LogEntry[]>();
  const [error, setError] = useState<string>();
  const viewRef = useRef<HTMLDivElement>(null);
  // Whether the reader is sitting at the newest line decides whether the poll
  // may scroll; otherwise every refresh drags them off what they were reading.
  const pinnedRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const data = await api<{ entries: LogEntry[] }>("/api/logs");
      setEntries(data.entries);
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const element = viewRef.current;
    if (!element || !pinnedRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [entries]);

  const handleScroll = () => {
    const element = viewRef.current;
    if (!element) return;
    pinnedRef.current =
      element.scrollHeight - element.scrollTop - element.clientHeight < 32;
  };

  return (
    <section className={styles.panel} aria-label="Diagnostics">
      <div className={styles.head}>
        <div>
          <Title3>Host problems</Title3>
          <Text as="p" className={styles.caption}>
            Warnings and errors this Host has logged since it started. Restarting it
            clears them, which is also what clears most of what they describe.
          </Text>
        </div>
        <Button
          appearance="secondary"
          icon={<ArrowClockwise20Regular />}
          onClick={() => void refresh()}
        >
          Refresh
        </Button>
      </div>

      {error ? (
        <Text className={styles.error}>{error}</Text>
      ) : entries === undefined ? (
        <Text className={styles.empty}>Loading…</Text>
      ) : entries.length === 0 ? (
        <Text className={styles.empty}>
          Nothing logged. The Host has not warned about anything since it started.
        </Text>
      ) : (
        <div className={styles.log} ref={viewRef} onScroll={handleScroll} role="log">
          {entries.map((entry, index) => (
            <div className={styles.line} key={`${entry.at}-${index}`}>
              <span className={styles.at}>{clockTime(entry.at)}</span>
              <span
                className={mergeClasses(
                  entry.level === "error" ? styles.error : undefined,
                  entry.level === "warn" ? styles.warn : undefined,
                )}
              >
                {entry.message}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
};
