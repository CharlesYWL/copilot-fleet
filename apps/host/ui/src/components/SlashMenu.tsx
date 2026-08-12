import { Text, makeStyles, tokens } from "@fluentui/react-components";
import type { SessionCommand } from "@fleet/protocol";

const useStyles = makeStyles({
  menu: {
    position: "absolute",
    left: "0",
    right: "0",
    bottom: "100%",
    marginBottom: "6px",
    maxHeight: "260px",
    overflowY: "auto",
    zIndex: 10,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    background: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow16,
    padding: "4px",
  },
  item: {
    display: "flex",
    alignItems: "baseline",
    gap: "8px",
    width: "100%",
    padding: "6px 8px",
    border: "none",
    borderRadius: tokens.borderRadiusSmall,
    background: "transparent",
    color: tokens.colorNeutralForeground1,
    cursor: "pointer",
    textAlign: "left",
  },
  active: {
    background: tokens.colorNeutralBackground1Selected,
  },
  name: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: "12px",
    flexShrink: 0,
  },
  hint: {
    color: tokens.colorBrandForeground2,
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: "11px",
    flexShrink: 0,
  },
  description: {
    color: tokens.colorNeutralForeground3,
    fontSize: "11px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  empty: {
    padding: "8px",
    color: tokens.colorNeutralForeground3,
    fontSize: "11px",
  },
});

export type SlashMenuProps = {
  commands: SessionCommand[];
  activeIndex: number;
  onPick: (command: SessionCommand) => void;
  onHover: (index: number) => void;
};

/**
 * The command list shown above the composer.
 *
 * Selection lives with the composer rather than here: the keys that move it
 * arrive in the textarea, and a menu that owned the highlight would have to be
 * told about every one of them.
 *
 * Items are mousedown-driven because a click would first blur the textarea,
 * and the composer closes the menu on blur — the pick would land on a menu
 * that had already gone.
 */
export const SlashMenu = ({ commands, activeIndex, onPick, onHover }: SlashMenuProps) => {
  const styles = useStyles();
  if (commands.length === 0) {
    return (
      <div className={styles.menu}>
        <Text className={styles.empty}>No matching commands</Text>
      </div>
    );
  }
  return (
    <div className={styles.menu} role="listbox" aria-label="Slash commands">
      {commands.map((command, index) => (
        <button
          key={command.name}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          className={`${styles.item} ${index === activeIndex ? styles.active : ""}`}
          onMouseDown={(event) => {
            event.preventDefault();
            onPick(command);
          }}
          onMouseEnter={() => onHover(index)}
        >
          <span className={styles.name}>/{command.name}</span>
          {command.hint ? <span className={styles.hint}>{command.hint}</span> : null}
          <span className={styles.description}>{command.description}</span>
        </button>
      ))}
    </div>
  );
};
