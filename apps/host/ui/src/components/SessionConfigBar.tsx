import {
  Menu,
  MenuItemRadio,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { ChevronDown12Regular } from "@fluentui/react-icons";
import type { SessionConfigOption } from "@fleet/protocol";
import { visibleConfigOptions } from "../lib/session-config";

const useStyles = makeStyles({
  bar: {
    display: "flex",
    alignItems: "center",
    minWidth: 0,
  },
  trigger: {
    display: "flex",
    alignItems: "center",
    gap: "3px",
    maxWidth: "190px",
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
  separator: {
    flexShrink: 0,
    width: "1px",
    height: "14px",
    margin: "0 4px",
    background: tokens.colorNeutralStroke2,
  },
  // The popover carries the label, so the trigger does not have to spend width
  // repeating "Model" next to the model's own name.
  heading: {
    display: "block",
    padding: "6px 10px 2px",
    color: tokens.colorNeutralForeground4,
    fontSize: "11px",
  },
});

export type SessionConfigBarProps = {
  options: SessionConfigOption[];
  disabled?: boolean;
  onChange: (configId: string, value: string) => void;
};

/**
 * The session's pickers, as a strip of compact controls.
 *
 * Each one shows only its current value. The composer is the busiest part of
 * the screen, and a row of labelled dropdowns above it spent a whole band
 * saying words that never change; the name lives in the menu that opens
 * instead, where there is room for it next to each choice.
 *
 * Menus open upwards because the strip sits at the bottom of the window, where
 * a downward popover would have nowhere to go.
 *
 * What is left out is decided by {@link visibleConfigOptions}, which drops the
 * settings the fleet has already made for this session.
 */
export const SessionConfigBar = ({
  options,
  disabled,
  onChange,
}: SessionConfigBarProps) => {
  const styles = useStyles();
  const usable = visibleConfigOptions(options);
  if (usable.length === 0) return null;

  return (
    <div className={styles.bar}>
      {usable.map((option, index) => {
        const current = option.choices.find(
          (choice) => choice.value === option.currentValue,
        );
        return (
          <div className={styles.bar} key={option.id}>
            {index > 0 ? <span className={styles.separator} aria-hidden /> : null}
            <Menu
              positioning="above-start"
              checkedValues={{ [option.id]: [option.currentValue] }}
              onCheckedValueChange={(_event, data) => {
                const next = data.checkedItems[0];
                // Compared against undefined rather than tested for truth: ""
                // is a selectable value (Copilot's default `agent`), and a
                // falsy check made that one choice impossible to pick.
                if (next === undefined || next === option.currentValue) return;
                onChange(option.id, next);
              }}
            >
              <MenuTrigger disableButtonEnhancement>
                <button
                  type="button"
                  className={styles.trigger}
                  disabled={disabled}
                  aria-label={option.name}
                  title={option.description || option.name}
                >
                  {/* An agent can report a value that predates the list it
                      sent, so the raw id is shown rather than nothing. */}
                  <span className={styles.value}>
                    {current?.name ?? option.currentValue}
                  </span>
                  <ChevronDown12Regular className={styles.chevron} />
                </button>
              </MenuTrigger>
              <MenuPopover>
                <MenuList>
                  <Text className={styles.heading}>{option.name}</Text>
                  {option.choices.map((choice) => (
                    <MenuItemRadio
                      key={choice.value}
                      name={option.id}
                      value={choice.value}
                    >
                      {choice.name}
                    </MenuItemRadio>
                  ))}
                </MenuList>
              </MenuPopover>
            </Menu>
          </div>
        );
      })}
    </div>
  );
};
