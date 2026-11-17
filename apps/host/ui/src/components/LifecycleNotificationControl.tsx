import { Button, Spinner, makeStyles, tokens } from "@fluentui/react-components";
import { Alert20Regular, AlertOff20Regular } from "@fluentui/react-icons";
import type { EffectiveNotificationPreference } from "../hooks/useNotificationPreference";

const useStyles = makeStyles({
  trigger: {
    color: tokens.colorNeutralForeground3,
  },
});

export function lifecyclePreferenceLabel(
  preference: EffectiveNotificationPreference,
): string {
  if (preference.source === "explicit") {
    return `${preference.lifecycleEnabled ? "On" : "Off"} for this agent`;
  }
  if (preference.source === "role") {
    return `${preference.lifecycleEnabled ? "On" : "Off"} by default for dependency agents`;
  }
  return `${preference.lifecycleEnabled ? "On" : "Off"} from application default`;
}

type LifecycleNotificationControlProps = {
  preference: EffectiveNotificationPreference | undefined;
  loading: boolean;
  onSet: (enabled: boolean) => Promise<boolean>;
};

/** A presentation-only preference control; it never sends a session command. */
export const LifecycleNotificationControl = ({
  preference,
  loading,
  onSet,
}: LifecycleNotificationControlProps) => {
  const styles = useStyles();
  if (loading) {
    return <Spinner size="tiny" aria-label="Loading lifecycle notifications" />;
  }
  if (!preference) return null;

  const label = lifecyclePreferenceLabel(preference);
  return (
    <Button
      className={styles.trigger}
      appearance="subtle"
      size="small"
      icon={preference.lifecycleEnabled ? <Alert20Regular /> : <AlertOff20Regular />}
      aria-label={`Lifecycle notifications: ${label}`}
      aria-pressed={preference.lifecycleEnabled}
      title={`Lifecycle notifications: ${label}`}
      onClick={() => void onSet(!preference.lifecycleEnabled)}
    />
  );
};
