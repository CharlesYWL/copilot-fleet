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
import { errorMessage } from "@fleet/protocol";
import { api } from "../hooks/useFleet";
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

export function AdministratorAdded({ administratorId }: { administratorId: string }) {
  const styles = useStyles();
  const [username, setUsername] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let abandoned = false;
    setUsername(undefined);
    setError(undefined);
    void api<{ administrators: { id: string; username: string }[] }>(
      "/api/auth/administrators",
    )
      .then(({ administrators }) => {
        if (abandoned) return;
        const administrator = administrators.find(({ id }) => id === administratorId);
        if (!administrator) {
          throw new Error(
            "This account is not in the administrator list. Return to Security to check its access.",
          );
        }
        setUsername(administrator.username);
      })
      .catch((reason: unknown) => {
        if (!abandoned) {
          setError(errorMessage(reason, "Could not confirm the administrator account"));
        }
      });
    return () => {
      abandoned = true;
    };
  }, [administratorId]);

  return (
    <div className={styles.screen}>
      <section className={styles.card} aria-label="Administrator account">
        <BrandMark size={36} />
        {error ? (
          <MessageBar intent="error">
            <MessageBarBody>{error}</MessageBarBody>
          </MessageBar>
        ) : username !== undefined ? (
          <>
            <Text as="h1" size={600} weight="semibold">
              Account added
            </Text>
            <MessageBar intent="success">
              <MessageBarBody>
                {username || "The selected Microsoft account"} is now a Fleet
                administrator. No further approval is needed.
              </MessageBarBody>
            </MessageBar>
            <Text>
              Your original Fleet session is unchanged. Close this tab and return to
              Security; the administrator list refreshes when you return.
            </Text>
          </>
        ) : (
          <Spinner label="Confirming administrator access..." />
        )}
        <Link href="/">Return to Fleet</Link>
      </section>
    </div>
  );
}
