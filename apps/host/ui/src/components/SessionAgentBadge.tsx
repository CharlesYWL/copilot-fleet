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
import { Bot16Regular } from "@fluentui/react-icons";
import type { SessionConfigOption } from "@fleet/protocol";
import { selectedAgent } from "../lib/session-config";

const useStyles = makeStyles({
  /*
   * Deliberately badge-shaped rather than picker-shaped, and sitting beside the
   * session's name rather than in the strip of settings above the composer.
   *
   * A custom agent is not a setting. It is loaded before the first prompt, it
   * governs every turn afterwards, and it survives both a compaction and a
   * resume — so it belongs with the things that say what this session is,
   * next to YOLO, rather than with the things you might change for the next
   * message.
   */
  badge: {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    maxWidth: "180px",
    height: "20px",
    padding: "0 7px",
    border: "none",
    borderRadius: tokens.borderRadiusCircular,
    fontFamily: tokens.fontFamilyBase,
    fontSize: "11px",
    fontWeight: tokens.fontWeightSemibold,
    lineHeight: "20px",
    cursor: "pointer",
    ":disabled": { cursor: "default" },
  },
  /** Stock Copilot: present so the control can be found, quiet so it is not read as news. */
  plain: {
    background: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground3,
    ":hover": { color: tokens.colorNeutralForeground1 },
  },
  /** A custom agent is the thing worth noticing, so it is the thing with colour. */
  custom: {
    background: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground2,
  },
  name: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  icon: { flexShrink: 0, fontSize: "12px" },
  heading: {
    display: "block",
    padding: "6px 10px 2px",
    color: tokens.colorNeutralForeground4,
    fontSize: "11px",
  },
  list: { maxHeight: "min(60vh, 420px)", overflowY: "auto" },
});

export type SessionAgentBadgeProps = {
  options: SessionConfigOption[];
  disabled?: boolean;
  onChange?: (configId: string, value: string) => void;
};

/**
 * Which agent a session is running as, next to its name.
 *
 * Renders nothing when Copilot offered no agent picker — that happens whenever
 * the session's working directory has no agent files near it, and an empty
 * control would imply a choice that does not exist there.
 */
export const SessionAgentBadge = ({
  options,
  disabled,
  onChange,
}: SessionAgentBadgeProps) => {
  const styles = useStyles();
  const agent = selectedAgent(options);
  if (!agent) return null;

  const label = `Agent: ${agent.name}`;
  const trigger = (
    <button
      type="button"
      className={`${styles.badge} ${agent.isCustom ? styles.custom : styles.plain}`}
      disabled={disabled || !onChange}
      title={agent.option.description || label}
      aria-label={label}
    >
      <Bot16Regular className={styles.icon} />
      <span className={styles.name}>{agent.name}</span>
    </button>
  );

  // Without a way to change it the badge is a readout, and a menu that cannot
  // be acted on is worse than none.
  if (disabled || !onChange) return trigger;

  return (
    <Menu
      checkedValues={{ [agent.option.id]: [agent.option.currentValue] }}
      onCheckedValueChange={(_event, data) =>
        onChange(agent.option.id, String(data.checkedItems[0] ?? ""))
      }
    >
      <MenuTrigger disableButtonEnhancement>{trigger}</MenuTrigger>
      <MenuPopover>
        <Text className={styles.heading}>{agent.option.name}</Text>
        <MenuList className={styles.list}>
          {agent.option.choices.map((choice) => (
            <MenuItemRadio key={choice.value} name={agent.option.id} value={choice.value}>
              {choice.name}
            </MenuItemRadio>
          ))}
        </MenuList>
      </MenuPopover>
    </Menu>
  );
};
