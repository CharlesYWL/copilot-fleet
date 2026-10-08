import { useEffect, useState } from "react";
import {
  Link,
  MessageBar,
  MessageBarBody,
  Spinner,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { announceIdentityConfirmed } from "../lib/auth";
import { BrandMark } from "./BrandMark";

const useStyles = makeStyles({
  screen: {
    minHeight: "100%",
    display: "grid",
    placeItems: "center",
    padding: "24px",
    boxSizing: "border-box",
    background: tokens.colorNeutralBackground2,
  },
  card: {
    width: "min(460px, 100%)",
    display: "flex",
    flexDirection: "column",
    gap: "18px",
    padding: "28px",
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    background: tokens.colorNeutralBackground1,
    overflowWrap: "anywhere",
  },
});

/**
 * Where a sign-in that only confirmed who you are lands.
 *
 * Settings opens that sign-in in a tab of its own and holds the change it was
 * confirming, so this tab's job is to hand back rather than to become a second
 * console: tell the waiting tab, then get out of the way.
 */
export function IdentityConfirmed() {
  const styles = useStyles();
  const [handedBack, setHandedBack] = useState<boolean>();

  useEffect(() => {
    let abandoned = false;
    const url = new URL(window.location.href);
    if (url.searchParams.has("reauthenticated")) {
      url.searchParams.delete("reauthenticated");
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    }
    void announceIdentityConfirmed().then((taken) => {
      if (abandoned) return;
      setHandedBack(taken);
      // Browsers only let a script close a tab a script opened, which this one
      // was; where they refuse, the copy below still says what to do.
      if (taken) window.close();
    });
    return () => {
      abandoned = true;
    };
  }, []);

  return (
    <div className={styles.screen}>
      <section className={styles.card} aria-label="Identity confirmed">
        <BrandMark size={36} />
        {handedBack === undefined ? (
          <Spinner label="Returning to the tab you came from…" />
        ) : (
          <>
            <Text as="h1" size={600} weight="semibold">
              Identity confirmed
            </Text>
            <MessageBar intent="success">
              <MessageBarBody>
                {handedBack
                  ? "The change you were confirming is finishing in the tab you came from. You can close this tab."
                  : "Return to the tab you started from; a change waiting there finishes on its own."}
              </MessageBarBody>
            </MessageBar>
            {!handedBack && (
              <Text>
                If you closed that tab, retry the change from Settings → Security within
                ten minutes and it will not ask again.
              </Text>
            )}
          </>
        )}
        <Link href="/">Return to Fleet</Link>
      </section>
    </div>
  );
}
