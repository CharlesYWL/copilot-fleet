import {
  Menu,
  MenuItem,
  MenuItemRadio,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { ChevronDown12Regular } from "@fluentui/react-icons";
import { CONTEXT_TIER_CONFIG_ID, type SessionConfigOption } from "@fleet/protocol";
import { visibleConfigOptions } from "../lib/session-config";

const useStyles = makeStyles({
  bar: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    flex: "1 1 0",
    gap: "4px",
    minWidth: 0,
  },
  trigger: {
    display: "flex",
    alignItems: "center",
    gap: "3px",
    minWidth: 0,
    maxWidth: "min(320px, 100%)",
    padding: "3px 6px",
    border: "none",
    borderRadius: tokens.borderRadiusMedium,
    background: "transparent",
    color: tokens.colorNeutralForeground3,
    fontFamily: tokens.fontFamilyBase,
    fontSize: "12px",
    lineHeight: "16px",
    cursor: "pointer",
    ":hover": {
      background: tokens.colorNeutralBackground1Hover,
      color: tokens.colorNeutralForeground1,
    },
    ":disabled": {
      cursor: "default",
      color: tokens.colorNeutralForegroundDisabled,
      background: "transparent",
    },
    ":focus-visible": {
      outline: `2px solid ${tokens.colorBrandStroke1}`,
      outlineOffset: "2px",
    },
  },
  value: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  chevron: {
    flexShrink: 0,
    opacity: 0.6,
  },
  popover: {
    minWidth: 0,
    maxWidth: "min(340px, calc(100vw - 24px))",
  },
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "16px",
    minWidth: 0,
  },
  selected: {
    minWidth: 0,
    maxWidth: "190px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: tokens.colorNeutralForeground3,
  },
  choice: {
    whiteSpace: "normal",
    overflowWrap: "anywhere",
  },
  // The popover carries the label, so the trigger does not have to spend width
  // repeating "Model" next to the model's own name.
  heading: {
    display: "block",
    padding: "6px 10px 2px",
    color: tokens.colorNeutralForeground4,
    fontSize: "11px",
    maxWidth: "300px",
    whiteSpace: "normal",
  },
  description: {
    display: "block",
    color: tokens.colorNeutralForeground3,
    fontSize: "11px",
    whiteSpace: "normal",
  },
  /**
   * Keeps a long picker inside the window.
   *
   * An agent that offers twenty models rendered twenty items tall, and the strip
   * it opens from sits at the bottom of the screen — so the list ran off the top
   * edge and the choices up there could not be reached, scrolled to, or even
   * seen. Capping the height turns that overflow into a scrollbar.
   *
   * Expressed against the viewport rather than as a fixed number of pixels
   * because the constraint is the window, not the list: a short window has to
   * clamp harder than a tall one, and the absolute cap only stops a very tall
   * window from opening a menu the eye has to travel.
   */
  list: {
    maxHeight: "min(60vh, 420px)",
    overflowY: "auto",
  },
});

export type SessionConfigBarProps = {
  options: SessionConfigOption[];
  /** Whose session this is: some pickers are the fleet's, not the operator's. */
  session?: { runRole?: string; state?: string; stopRequested?: boolean | undefined };
  disabled?: boolean;
  onChange: (configId: string, value: string) => void;
};

const modelSettingIds = ["model", "reasoning_effort", CONTEXT_TIER_CONFIG_ID];
const currentLabel = (option: SessionConfigOption) =>
  option.choices.find((choice) => choice.value === option.currentValue)?.name ??
  (option.currentValue || option.name);

/** Model settings share one chip; fleet-owned pickers stay out of the composer. */
export const SessionConfigBar = ({
  options,
  session,
  disabled,
  onChange,
}: SessionConfigBarProps) => {
  const styles = useStyles();
  const usable = visibleConfigOptions(options, session ?? {});
  if (usable.length === 0) return null;
  const modelSettings = modelSettingIds.flatMap((id) =>
    usable.filter((option) => option.id === id),
  );
  const otherSettings = usable.filter((option) => !modelSettingIds.includes(option.id));
  const summary =
    ["model", "reasoning_effort"]
      .flatMap((id) => options.filter((option) => option.id === id).map(currentLabel))
      .join(" · ") || modelSettings.map(currentLabel).join(" · ");

  const picker = (option: SessionConfigOption, nested = false) => {
    const contextLocked =
      option.id === CONTEXT_TIER_CONFIG_ID &&
      (session?.state !== "idle" || session.stopRequested);
    const locked = Boolean(disabled || contextLocked);
    const description = contextLocked
      ? `Wait for the session to be idle to change the context window. ${option.description}`
      : option.description || option.name;
    const label = option.id === "reasoning_effort" ? "Effort" : option.name;
    const value = currentLabel(option);
    return (
      <Menu
        key={option.id}
        positioning={nested ? "after-top" : "above-start"}
        checkedValues={{ [option.id]: [option.currentValue] }}
        onCheckedValueChange={(_event, data) => {
          const next = data.checkedItems[0];
          // An empty string is a real choice, not an absent selection.
          if (locked || next === undefined || next === option.currentValue) return;
          onChange(option.id, next);
        }}
      >
        <MenuTrigger disableButtonEnhancement>
          {nested ? (
            <MenuItem
              disabled={locked}
              content={{ className: styles.row }}
              title={description}
              aria-label={`${label}: ${value}`}
            >
              <span>{label}</span>
              <span className={styles.selected}>{value}</span>
            </MenuItem>
          ) : (
            <button
              type="button"
              className={styles.trigger}
              disabled={locked}
              aria-label={option.name}
              title={description}
            >
              <span className={styles.value}>{value}</span>
              <ChevronDown12Regular className={styles.chevron} />
            </button>
          )}
        </MenuTrigger>
        <MenuPopover className={styles.popover}>
          <MenuList className={styles.list} aria-label={option.name}>
            <Text className={styles.heading}>{option.name}</Text>
            {option.description && (
              <Text className={styles.heading}>{option.description}</Text>
            )}
            {option.choices.map((choice) => (
              <MenuItemRadio
                key={choice.value}
                name={option.id}
                value={choice.value}
                disabled={locked}
                content={{ className: styles.choice }}
              >
                {choice.name}
                {choice.description && (
                  <span className={styles.description}>{choice.description}</span>
                )}
              </MenuItemRadio>
            ))}
          </MenuList>
        </MenuPopover>
      </Menu>
    );
  };

  return (
    <div className={styles.bar}>
      {modelSettings.length > 0 && (
        <Menu positioning="above-start">
          <MenuTrigger disableButtonEnhancement>
            <button
              type="button"
              className={styles.trigger}
              disabled={disabled}
              aria-label="Model settings"
              title={summary}
            >
              <span className={styles.value}>{summary}</span>
              <ChevronDown12Regular className={styles.chevron} />
            </button>
          </MenuTrigger>
          <MenuPopover className={styles.popover}>
            <MenuList className={styles.list} aria-label="Model settings">
              {modelSettings.map((option) => picker(option, true))}
            </MenuList>
          </MenuPopover>
        </Menu>
      )}
      {otherSettings.map((option) => picker(option))}
    </div>
  );
};
