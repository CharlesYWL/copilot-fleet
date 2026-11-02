import {
  useId,
  useMemo,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import {
  SearchBox,
  makeStyles,
  mergeClasses,
  shorthands,
  tokens,
  type InputOnChangeData,
  type SearchBoxChangeEvent,
} from "@fluentui/react-components";
import {
  ChevronRight12Regular,
  Flow20Regular,
  Folder20Regular,
  Globe20Regular,
  Server20Regular,
  Settings20Regular,
  ShieldLock20Regular,
  Stethoscope20Regular,
  type FluentIcon,
} from "@fluentui/react-icons";
import { useSearchBoxClear } from "../hooks/useSearchBoxClear";
import { searchTerms } from "../lib/search-text";
import {
  searchSettings,
  sectionLabel,
  type SettingsSearchEntry,
  type SettingsTab,
} from "../lib/settings-search";
import { HighlightedText } from "./HighlightedText";

const useStyles = makeStyles({
  /** Anchors the result list, which spreads to the full width of the search. */
  root: {
    position: "relative",
    width: "100%",
  },
  searchBox: {
    width: "100%",
    maxWidth: "100%",
  },
  /**
   * Full width and floating, like the Windows Settings search it mirrors: the
   * page underneath keeps its place, and the list is closed as soon as focus
   * leaves the search, so it never sits over something being worked on.
   */
  list: {
    position: "absolute",
    insetInlineStart: 0,
    insetInlineEnd: 0,
    top: "calc(100% + 4px)",
    zIndex: 10,
    maxHeight: "min(440px, 60vh)",
    overflowY: "auto",
    margin: 0,
    padding: "6px",
    listStyleType: "none",
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusLarge,
    background: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow28,
  },
  option: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: "12px",
    minHeight: "40px",
    padding: "6px 12px",
    borderRadius: tokens.borderRadiusMedium,
    color: tokens.colorNeutralForeground1,
    cursor: "pointer",
  },
  /** The highlighted result: a raised row with a brand bar on its leading edge. */
  activeOption: {
    background: tokens.colorNeutralBackground1Hover,
    "::before": {
      content: '""',
      position: "absolute",
      insetInlineStart: 0,
      top: "10px",
      bottom: "10px",
      width: "3px",
      borderRadius: "2px",
      background: tokens.colorBrandStroke1,
    },
    "@media (forced-colors: active)": {
      ...shorthands.outline("2px", "solid", "Highlight"),
    },
  },
  icon: {
    flexShrink: 0,
    display: "grid",
    placeItems: "center",
    color: tokens.colorNeutralForeground2,
    fontSize: "20px",
  },
  path: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "4px 6px",
    minWidth: 0,
  },
  section: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  separator: {
    flexShrink: 0,
    color: tokens.colorNeutralForeground4,
  },
  title: {
    fontSize: tokens.fontSizeBase300,
    overflowWrap: "anywhere",
  },
  empty: {
    padding: "10px 12px",
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  /** Read out by assistive technology, invisible on screen. */
  visuallyHidden: {
    position: "absolute",
    width: "1px",
    height: "1px",
    margin: "-1px",
    padding: 0,
    overflow: "hidden",
    clip: "rect(0 0 0 0)",
    whiteSpace: "nowrap",
    ...shorthands.borderStyle("none"),
  },
});

const sectionIcons: Record<SettingsTab, FluentIcon> = {
  general: Settings20Regular,
  orchestrator: Flow20Regular,
  security: ShieldLock20Regular,
  tunnel: Globe20Regular,
  nodes: Server20Regular,
  workspaces: Folder20Regular,
  diagnostics: Stethoscope20Regular,
};

/** A node or workspace shows what it is; anything else shows its page. */
const iconFor = (entry: SettingsSearchEntry): FluentIcon => {
  if (entry.kind === "node") return Server20Regular;
  if (entry.kind === "workspace") return Folder20Regular;
  return sectionIcons[entry.tab];
};

/** What a result is called aloud, where the visual row splits it in two. */
const spokenName = (entry: SettingsSearchEntry): string => {
  const section = sectionLabel(entry.tab);
  if (entry.kind === "section") return `${entry.title} settings page`;
  if (entry.kind === "node") return `${entry.title}, node in ${section}`;
  if (entry.kind === "workspace") return `${entry.title}, workspace in ${section}`;
  return `${entry.title}, ${section}`;
};

type SettingsSearchProps = {
  entries: readonly SettingsSearchEntry[];
  /** Called with the chosen result; the search clears itself afterwards. */
  onSelect: (entry: SettingsSearchEntry) => void;
  /**
   * Whether a result can still lead somewhere on this Host. Asked as the list
   * is drawn, so it can look at pages that have loaded since the last keystroke.
   */
  isAvailable?: (entry: SettingsSearchEntry) => boolean;
};

/**
 * The search box above the Settings tabs, and the list of what it finds.
 *
 * A combobox in the ARIA sense: focus stays in the box while the arrow keys
 * move a highlight through the list, so typing and choosing never compete for
 * the caret. Each row reads "Section › Setting" with the match marked, the way
 * the Windows Settings search does.
 */
export const SettingsSearch = ({
  entries,
  onSelect,
  isAvailable = () => true,
}: SettingsSearchProps) => {
  const styles = useStyles();
  const listId = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const terms = useMemo(() => searchTerms(query), [query]);
  const clearSearch = useSearchBoxClear("Clear settings search", query.length > 0);
  // Not memoised: `isAvailable` reads the pages as drawn, which can change
  // without anything here changing, and ranking ~60 entries costs nothing.
  const results = searchSettings(entries, query).filter((entry) => isAvailable(entry));
  const searching = terms.length > 0;
  const expanded = open && searching;
  const active = Math.min(activeIndex, Math.max(results.length - 1, 0));
  const optionId = (index: number) => `${listId}-option-${index}`;

  const handleChange = (_event: SearchBoxChangeEvent, data: InputOnChangeData) => {
    setQuery(data.value);
    setActiveIndex(0);
    setOpen(true);
  };

  const choose = (entry: SettingsSearchEntry) => {
    setQuery("");
    setOpen(false);
    setActiveIndex(0);
    onSelect(entry);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      if (!expanded && !query) return;
      event.preventDefault();
      event.stopPropagation();
      if (expanded) {
        setOpen(false);
        return;
      }
      setQuery("");
      return;
    }
    if (!searching) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!expanded) {
        setOpen(true);
        return;
      }
      if (results.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((active + step + results.length) % results.length);
      return;
    }
    if (event.key !== "Enter" || !expanded) return;
    event.preventDefault();
    const entry = results[active];
    if (entry) choose(entry);
  };

  /** Closes the list once focus has left both the box and the list. */
  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setOpen(false);
  };

  /** Keeps focus, and so the caret, in the box while a row is clicked. */
  const handleOptionMouseDown = (event: MouseEvent<HTMLLIElement>) => {
    event.preventDefault();
  };

  return (
    <div className={styles.root} onBlur={handleBlur}>
      <SearchBox
        className={styles.searchBox}
        value={query}
        placeholder="Find a setting"
        role="combobox"
        aria-label="Search settings"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        aria-activedescendant={
          expanded && results.length > 0 ? optionId(active) : undefined
        }
        autoComplete="off"
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onFocus={() => setOpen(true)}
        {...clearSearch}
      />
      <span className={styles.visuallyHidden} role="status" aria-live="polite">
        {searching
          ? results.length === 0
            ? "No results"
            : `${results.length} ${results.length === 1 ? "result" : "results"}`
          : ""}
      </span>
      {expanded &&
        (results.length === 0 ? (
          <div className={styles.list}>
            <p className={styles.empty}>No settings match “{query.trim()}”.</p>
          </div>
        ) : (
          <ul
            id={listId}
            className={styles.list}
            role="listbox"
            aria-label="Settings search results"
          >
            {results.map((entry, index) => {
              const Icon = iconFor(entry);
              return (
                <li
                  key={entry.id}
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === active}
                  aria-label={spokenName(entry)}
                  className={mergeClasses(
                    styles.option,
                    index === active && styles.activeOption,
                  )}
                  onMouseDown={handleOptionMouseDown}
                  onMouseMove={() => setActiveIndex(index)}
                  onClick={() => choose(entry)}
                >
                  <span className={styles.icon} aria-hidden="true">
                    <Icon />
                  </span>
                  <span className={styles.path}>
                    {entry.kind !== "section" && (
                      <>
                        <span className={styles.section}>{sectionLabel(entry.tab)}</span>
                        <ChevronRight12Regular
                          className={styles.separator}
                          aria-hidden="true"
                        />
                      </>
                    )}
                    <span className={styles.title}>
                      <HighlightedText text={entry.title} terms={terms} />
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        ))}
    </div>
  );
};
