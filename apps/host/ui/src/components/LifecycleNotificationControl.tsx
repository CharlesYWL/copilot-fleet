import {
  Button,
  Menu,
  MenuItem,
  MenuItemRadio,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Spinner,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { Alert20Regular } from "@fluentui/react-icons";
import type { EffectiveNotificationPreference } from "../hooks/useNotificationPreference";

const useStyles = makeStyles({
  trigger: {
    maxWidth: "260px",
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
  onReset: () => Promise<boolean>;
};

/** A presentation-only preference control; it never sends a session command. */
export const LifecycleNotificationControl = ({
  preference,
  loading,
  onSet,
  onReset,
}: LifecycleNotificationControlProps) => {
  const styles = useStyles();
  if (loading) {
    return <Spinner size="tiny" label="Loading lifecycle notifications" />;
  }
  if (!preference) return null;

  const label = lifecyclePreferenceLabel(preference);
  return (
    <Menu
      checkedValues={{
        lifecycle: [preference.lifecycleEnabled ? "on" : "off"],
      }}
      onCheckedValueChange={(_event, data) => {
        const enabled = data.checkedItems[0] === "on";
        if (enabled === preference.lifecycleEnabled && preference.source === "explicit") {
          return;
        }
        void onSet(enabled);
      }}
    >
      <MenuTrigger disableButtonEnhancement>
        <Button
          className={styles.trigger}
          appearance="subtle"
          size="small"
          icon={<Alert20Regular />}
          aria-label={`Lifecycle notifications: ${label}`}
          title={`Lifecycle notifications: ${label}`}
        >
          {label}
        </Button>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          <MenuItemRadio name="lifecycle" value="on">
            On for this agent
          </MenuItemRadio>
          <MenuItemRadio name="lifecycle" value="off">
            Off for this agent
          </MenuItemRadio>
          {preference.source === "explicit" && (
            <MenuItem onClick={() => void onReset()}>Use inherited default</MenuItem>
          )}
        </MenuList>
      </MenuPopover>
    </Menu>
  );
};
