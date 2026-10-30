import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FocusEvent,
  type KeyboardEvent,
} from "react";
import {
  shorthands,
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  SearchBox,
  Text,
  Tree,
  TreeItem,
  TreeItemLayout,
  makeStyles,
  mergeClasses,
  tokens,
  type InputOnChangeData,
  type SearchBoxChangeEvent,
  type TreeOpenChangeData,
} from "@fluentui/react-components";
import {
  Add20Regular,
  ChevronDown20Regular,
  ChevronRight20Regular,
  Delete20Regular,
  DataUsage20Regular,
  Chat20Regular,
  Flow16Regular,
  Flow20Regular,
  Folder20Regular,
  MoreHorizontal20Regular,
  Search20Regular,
  Server20Regular,
  Settings20Regular,
  Star20Filled,
  Stop20Regular,
} from "@fluentui/react-icons";
import type {
  FleetNode,
  FleetSession,
  Placement,
  SessionEvent,
  Workspace,
} from "@fleet/protocol";
import {
  groupSessionsByWorkspace,
  type SessionWorkspaceGroup,
} from "../lib/session-groups";
import { searchTerms } from "../lib/search-text";
import { useSearchBoxClear } from "../hooks/useSearchBoxClear";
import {
  countSearchMatches,
  filterSessionGroups,
  filterSessions,
} from "../lib/session-search";
import {
  DRAG_MIME,
  decodeDrag,
  edgeFromPointer,
  encodeDrag,
  reorder,
  type DropEdge,
} from "../lib/drag-drop";
import { useCatalog } from "../hooks/useCatalog";
import { sessionLabel } from "../lib/session-label";
import { customAgentName } from "../lib/session-config";
import { sessionStatusDescriptor, sessionStatusLabel } from "../lib/session-status";
import {
  nextClosedItems,
  nodeKey,
  treeActivity,
  workspaceKey,
  type TreeReading,
} from "../lib/tree-collapse";
import { StatusIndicator } from "./StatusIndicator";
import { HighlightedText } from "./HighlightedText";
import { statusVisuals } from "../theme";
import type { AppView } from "../App";

/**
 * What the down arrow moves to from the search box: the first result.
 *
 * Results are tagged rather than found by role, so section controls such as
 * "Manage favorites" are stepped over on the way.
 */
const FIRST_RESULT_SELECTOR = '[data-search-result], [role="treeitem"]';

/** Every collapsible row of the tree: each workspace, and each node under one. */
const branchKeys = (groups: readonly SessionWorkspaceGroup[]): string[] =>
  groups.flatMap((group) => [
    workspaceKey(group.workspaceId),
    ...group.nodes.map((item) => nodeKey(group.workspaceId, item.nodeId)),
  ]);

const useStyles = makeStyles({
  sidebar: {
    width: "280px",
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    background: tokens.colorNeutralBackground2,
  },
  scroll: {
    flexGrow: 1,
    overflowY: "auto",
    overflowX: "hidden",
    padding: "10px 8px",
  },
  /**
   * The "Fleet" heading row, which also holds the session search.
   *
   * Collapsed it is the label with a search button at its end; opened, the
   * same row becomes the search box, so searching costs no extra line. While
   * open it sticks to the top of the list, so the box stays in reach as the
   * results scroll under it.
   */
  fleetHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "4px",
    minHeight: "32px",
    paddingRight: "2px",
  },
  fleetHeaderOpen: {
    position: "sticky",
    top: "-10px",
    zIndex: 3,
    margin: "-10px -8px 4px",
    padding: "10px 8px 6px",
    background: tokens.colorNeutralBackground2,
  },
  searchBox: {
    flexGrow: 1,
    width: "100%",
    maxWidth: "100%",
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
  /** A section's title while searching, when it is held open and cannot fold. */
  sectionHeading: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
  },
  sectionLabel: {
    display: "block",
    padding: "6px 10px",
    fontSize: "10px",
    letterSpacing: "1.4px",
    textTransform: "uppercase",
    color: tokens.colorNeutralForeground4,
  },
  sectionDisclosure: {
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: "4px",
    ...shorthands.borderStyle("none"),
    background: "transparent",
    cursor: "pointer",
    textAlign: "left",
    ":hover": { color: tokens.colorNeutralForeground3 },
  },
  row: {
    borderRadius: tokens.borderRadiusMedium,
    minWidth: 0,
    // The layout's main slot defaults to min-width:auto, which stops the
    // session label from ever shrinking enough to ellipsize.
    "& .fui-TreeItemLayout__main": {
      minWidth: 0,
      overflow: "hidden",
    },
  },
  selectedRow: {
    background: tokens.colorNeutralBackground6,
  },
  sessionLabel: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    minWidth: 0,
  },
  sessionName: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  /** Marks a session the engine is driving, not the operator. */
  dispatchedMark: {
    display: "inline-flex",
    alignItems: "center",
    flexShrink: 0,
    color: tokens.colorBrandForeground2,
  },
  offline: {
    color: tokens.colorNeutralForeground4,
  },
  draggable: {
    cursor: "grab",
    ":active": { cursor: "grabbing" },
  },
  /*
   * The insertion line, as a pseudo-element rather than an inset shadow.
   *
   * A row paints its own background across its whole box, so a shadow drawn
   * underneath it never showed: the rule was applied and nothing appeared.
   * This draws above the row, inset by a pixel so a clipped parent cannot
   * swallow it.
   */
  dropBefore: {
    position: "relative",
    "::after": {
      content: '""',
      position: "absolute",
      left: 0,
      right: 0,
      top: 0,
      height: "3px",
      borderRadius: "2px",
      background: tokens.colorBrandStroke1,
      zIndex: 2,
    },
  },
  dropAfter: {
    position: "relative",
    "::after": {
      content: '""',
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      height: "3px",
      borderRadius: "2px",
      background: tokens.colorBrandStroke1,
      zIndex: 2,
    },
  },
  dropTarget: {
    outline: `2px solid ${tokens.colorBrandStroke1}`,
    outlineOffset: "-2px",
    borderRadius: tokens.borderRadiusMedium,
  },
  empty: {
    padding: "10px 12px",
    color: tokens.colorNeutralForeground4,
    fontSize: tokens.fontSizeBase200,
  },
  footer: {
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    padding: "10px",
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  navButton: {
    justifyContent: "flex-start",
  },
  /** The one row that is not a workspace, so it is styled as its own thing. */
  /**
   * The row that holds the fold control and the link into the board.
   *
   * The frame lives here rather than on either control, because they are two
   * buttons — one inside the other is invalid, and it made the row announce
   * itself as "Hide conversations Orchestrator".
   */
  orchestrationRow: {
    display: "flex",
    alignItems: "center",
    gap: "2px",
    width: "100%",
    marginBottom: "4px",
    paddingLeft: "6px",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    background: "transparent",
    ":hover": { background: tokens.colorNeutralBackground3 },
  },
  orchestration: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    flexGrow: 1,
    minWidth: 0,
    padding: "8px 10px 8px 4px",
    ...shorthands.borderStyle("none"),
    borderRadius: tokens.borderRadiusMedium,
    background: "transparent",
    color: tokens.colorNeutralForeground1,
    font: "inherit",
    textAlign: "left",
    cursor: "pointer",
  },
  orchestrationActive: {
    background: tokens.colorNeutralBackground3,
    // Griffel wants the longhand here, since the shorthand is set above.
    borderTopColor: tokens.colorBrandStroke1,
    borderRightColor: tokens.colorBrandStroke1,
    borderBottomColor: tokens.colorBrandStroke1,
    borderLeftColor: tokens.colorBrandStroke1,
  },
  /** The fold control, sized to the tree's own chevrons so the rows line up. */
  disclosure: {
    flexShrink: 0,
    display: "grid",
    placeItems: "center",
    width: "20px",
    height: "20px",
    ...shorthands.borderStyle("none"),
    borderRadius: tokens.borderRadiusSmall,
    background: "transparent",
    color: tokens.colorNeutralForeground3,
    cursor: "pointer",
    "> svg": { fontSize: "16px" },
    ":hover": {
      background: tokens.colorNeutralBackground1Hover,
      color: tokens.colorNeutralForeground1,
    },
  },
  orchestrationLabel: {
    flexGrow: 1,
    minWidth: 0,
    fontWeight: tokens.fontWeightSemibold,
    /*
     * One line, always.
     *
     * These labels were fixed short strings until conversations started naming
     * themselves after whatever a person asked for. A 48-character title
     * wrapped to three lines, pushing the icon and the status dot to the
     * vertical middle of a row that was no longer row-shaped. The whole text
     * is on the row's tooltip.
     */
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  orchestrationCount: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    fontVariantNumeric: "tabular-nums",
  },
  /** Amber only, and only for what a person has to act on. */
  attentionBadge: {
    minWidth: "18px",
    height: "18px",
    display: "grid",
    placeItems: "center",
    padding: "0 5px",
    borderRadius: "9px",
    background: statusVisuals.attention.surface,
    color: statusVisuals.attention.foreground,
    ...shorthands.border("1px", "solid", statusVisuals.attention.border),
    fontSize: "10px",
    fontWeight: tokens.fontWeightSemibold,
    fontVariantNumeric: "tabular-nums",
  },
  /** The lead's conversation, one level under the orchestrator row. */
  leadRow: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    width: "100%",
    minHeight: "34px",
    padding: "0 12px 0 28px",
    ...shorthands.borderStyle("none"),
    borderRadius: tokens.borderRadiusMedium,
    background: "transparent",
    color: tokens.colorNeutralForeground2,
    font: "inherit",
    textAlign: "left",
    cursor: "pointer",
    // The icon and the status dot keep their size; only the name gives way.
    "> svg": { flexShrink: 0 },
    ":hover": { background: tokens.colorNeutralBackground1Hover },
  },
  favoriteHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  favoriteManage: {
    flexShrink: 0,
    display: "grid",
    placeItems: "center",
    width: "30px",
    height: "30px",
    padding: 0,
    ...shorthands.borderStyle("none"),
    borderRadius: tokens.borderRadiusMedium,
    background: "transparent",
    color: tokens.colorNeutralForeground3,
    cursor: "pointer",
    ":hover": { background: tokens.colorNeutralBackground1Hover },
  },
  favoriteEntry: {
    display: "flex",
    alignItems: "center",
    minWidth: 0,
    padding: "1px 4px 1px 28px",
  },
  favoriteLink: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    flexGrow: 1,
    minWidth: 0,
    minHeight: "32px",
    padding: "0 6px",
    ...shorthands.borderStyle("none"),
    borderRadius: tokens.borderRadiusMedium,
    background: "transparent",
    color: tokens.colorNeutralForeground2,
    font: "inherit",
    textAlign: "left",
    cursor: "pointer",
    ":hover": { background: tokens.colorNeutralBackground1Hover },
  },
});

type SidebarProps = {
  nodes: FleetNode[];
  workspaces: Workspace[];
  sessions: FleetSession[];
  placements: Placement[];
  selectedSessionId: string | undefined;
  view: AppView;
  endedCount: number;
  /** Live non-lead sessions that the fleet-wide bulk Stop would affect. */
  liveAgentCount: number;
  cleanupOrchestratorCount: number;
  /** Live work across the fleet, shown beside the Orchestrator row. */
  liveWorkCount: number;
  /** Tasks waiting on a person; drawn separately because amber means act. */
  attentionCount: number;
  /**
   * The orchestrator's conversations, newest first.
   *
   * Plural because the Host runs as many as you open: each is a thread you talk
   * to, with its own tasks under it, and they are listed here for the same
   * reason a chat app lists them — you pick one up, not "the" one.
   */
  leadSessions: readonly FleetSession[];
  dismissedLeadSessions?: readonly FleetSession[];
  favoriteSessions: readonly FleetSession[];
  waitingPermissions: readonly SessionEvent[];
  onSelectSession: (sessionId: string) => void;
  onSelectLeadSession: (sessionId: string) => void;
  onRestoreLeadSession?: (sessionId: string) => void;
  onDeleteLeadSession: (sessionId: string) => Promise<boolean>;
  /** Starts another conversation with the orchestrator. */
  onNewConversation: () => void;
  onNewSession: () => void;
  onSelectView: (view: Exclude<AppView, "session" | "overview">) => void;
  onStopAllAgents: () => void;
  onCleanupOrchestrators: () => void;
  onManageFavorites: () => void;
  onClearEnded: () => void;
};

export const Sidebar = ({
  nodes,
  workspaces,
  sessions,
  placements,
  selectedSessionId,
  view,
  endedCount,
  liveAgentCount,
  cleanupOrchestratorCount,
  liveWorkCount,
  attentionCount,
  leadSessions,
  dismissedLeadSessions = [],
  favoriteSessions,
  waitingPermissions,
  onSelectSession,
  onSelectLeadSession,
  onRestoreLeadSession,
  onDeleteLeadSession,
  onNewConversation,
  onNewSession,
  onSelectView,
  onStopAllAgents,
  onCleanupOrchestrators,
  onManageFavorites,
  onClearEnded,
}: SidebarProps) => {
  const styles = useStyles();
  const [closedItems, setClosedItems] = useState<ReadonlySet<string>>(new Set());
  /*
   * Conversations fold away like a workspace's sessions do, and for the same
   * reason: this list grows with use, and it sits above everything else in the
   * sidebar. Open by default and remembered only when closed, so a fleet with
   * one conversation never has to open anything.
   */
  const [conversationsClosed, setConversationsClosed] = useState(false);
  const [favoritesClosed, setFavoritesClosed] = useState(false);
  const [dismissedClosed, setDismissedClosed] = useState(true);
  const [deleteLead, setDeleteLead] = useState<FleetSession>();
  const [deletingLead, setDeletingLead] = useState(false);
  const [dropTarget, setDropTarget] = useState<{ key: string; edge: DropEdge }>();
  /*
   * The search narrows every section to what it names and holds open the
   * branches it found, without touching the folds the tree keeps for itself:
   * those go on being tracked underneath, so clearing the box puts the tree
   * back exactly as it would have been. Folding a branch by hand during a
   * search lasts until the search changes, since a new search is a new
   * question and its answers should all be visible.
   */
  const [query, setQuery] = useState("");
  /** Whether the search box is out; it folds back into an icon once cleared. */
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchClosed, setSearchClosed] = useState<{
    query: string;
    keys: ReadonlySet<string>;
  }>({ query: "", keys: new Set() });
  const resultsRef = useRef<HTMLDivElement>(null);
  const searchToggleRef = useRef<HTMLButtonElement>(null);
  const terms = useMemo(() => searchTerms(query), [query]);
  const searching = terms.length > 0;
  const clearSearch = useSearchBoxClear("Close session search", searchOpen);
  const { updatePlacement, reorderPlacements, reorderWorkspaces, reorderSessions } =
    useCatalog();

  /** The tree shows a node under a workspace; that pairing is a placement. */
  const placementFor = (workspaceId: string, nodeId: string) =>
    placements.find(
      (entry) => entry.workspaceId === workspaceId && entry.nodeId === nodeId,
    );

  const groups = useMemo(
    () => groupSessionsByWorkspace(sessions, nodes, workspaces, placements),
    [sessions, nodes, workspaces, placements],
  );
  /** The tree as shown: every group, or only what the search found. */
  const visibleGroups = useMemo(
    () => filterSessionGroups(groups, terms),
    [groups, terms],
  );
  const visibleFavorites = useMemo(
    () => filterSessions(favoriteSessions, terms),
    [favoriteSessions, terms],
  );
  const visibleLeads = useMemo(
    () => filterSessions(leadSessions, terms),
    [leadSessions, terms],
  );
  const visibleDismissed = useMemo(
    () => filterSessions(dismissedLeadSessions, terms),
    [dismissedLeadSessions, terms],
  );
  const matchCount = searching
    ? countSearchMatches(visibleGroups, [
        ...visibleFavorites,
        ...visibleLeads,
        ...visibleDismissed,
      ])
    : 0;
  /** A fold made during this search; cleared by moving on to another one. */
  const closedInSearch = searchClosed.query === query ? searchClosed.keys : undefined;
  const openItems = useMemo(
    () =>
      searching
        ? branchKeys(visibleGroups).filter((key) => !closedInSearch?.has(key))
        : branchKeys(groups).filter((key) => !closedItems.has(key)),
    [searching, visibleGroups, closedInSearch, groups, closedItems],
  );
  /*
   * Sections hold what they found open while searching, and do not offer the
   * fold: a collapsed Favorites hiding the one match would be the search
   * failing silently. The operator's own choice comes back with the clear.
   */
  const showFavorites = searching ? visibleFavorites.length > 0 : true;
  const favoritesOpen = searching || !favoritesClosed;
  const conversationsOpen = searching || !conversationsClosed;
  const dismissedOpen = searching || !dismissedClosed;

  /*
   * A row folds itself away once nothing under it is running, and opens again
   * when work turns up there — a session created, or one back from offline or
   * stopped. Done in an effect against the previous reading, so only a change
   * moves a row and a branch the operator opened by hand stays open. The branch
   * holding the session on screen is never folded, and opens when the operator
   * moves to a session the tree was not showing.
   */
  const reading = useMemo<TreeReading>(
    () => ({
      activity: treeActivity(groups),
      selectedSessionId: view === "session" ? selectedSessionId : undefined,
    }),
    [groups, selectedSessionId, view],
  );
  const lastReading = useRef<TreeReading | undefined>(undefined);
  useEffect(() => {
    const previous = lastReading.current;
    setClosedItems((closed) => nextClosedItems(closed, previous, reading));
    lastReading.current = reading;
  }, [reading]);

  const revealSelectedRow = useCallback((row: HTMLDivElement | null) => {
    row?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, []);

  const handleOpenChange = (_event: unknown, data: TreeOpenChangeData) => {
    const key = String(data.value);
    const toggle = (previous: ReadonlySet<string>) => {
      const next = new Set(previous);
      if (data.open) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    };
    if (searching) {
      setSearchClosed((previous) => ({
        query,
        keys: toggle(previous.query === query ? previous.keys : new Set()),
      }));
      return;
    }
    setClosedItems(toggle);
  };

  /** Opens the search box in place of the "Fleet" label and puts the caret in it. */
  const handleOpenSearch = () => setSearchOpen(true);

  /** Empties and folds the search away, handing focus back to its button. */
  const closeSearch = () => {
    setQuery("");
    setSearchOpen(false);
  };

  /*
   * Focus goes back to the search button when the box folds away, so a
   * keyboard user is never left on a removed element. (The box focuses
   * itself as it opens.)
   */
  const searchWasOpen = useRef(false);
  useEffect(() => {
    if (!searchOpen && searchWasOpen.current) searchToggleRef.current?.focus();
    searchWasOpen.current = searchOpen;
  }, [searchOpen]);

  const handleSearchChange = (event: SearchBoxChangeEvent, data: InputOnChangeData) => {
    // The clear button reports an empty value through a click; that closes it.
    if (event.type === "click") {
      closeSearch();
      return;
    }
    setQuery(data.value);
  };

  /** Escape closes the search; the down arrow steps into the first result. */
  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeSearch();
      return;
    }
    if (event.key !== "ArrowDown" || !searching) return;
    const first = resultsRef.current?.querySelector<HTMLElement>(FIRST_RESULT_SELECTOR);
    if (!first) return;
    event.preventDefault();
    first.focus();
  };

  /** An empty box gives its row back to the label once focus leaves it. */
  const handleSearchBlur = (event: FocusEvent<HTMLSpanElement>) => {
    if (query) return;
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setSearchOpen(false);
  };

  const handleSessionKeyDown = (sessionId: string) => (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onSelectSession(sessionId);
  };

  return (
    <nav className={styles.sidebar} aria-label="Fleet navigation">
      <div className={styles.scroll} ref={resultsRef}>
        <div
          className={mergeClasses(
            styles.fleetHeader,
            searchOpen && styles.fleetHeaderOpen,
          )}
          role="search"
          aria-label="Session search"
        >
          {searchOpen ? (
            <SearchBox
              // Mounted only when the icon is clicked, so focus goes straight in.
              autoFocus
              className={styles.searchBox}
              size="small"
              value={query}
              placeholder="Search sessions, nodes, projects"
              aria-label="Search sessions"
              onChange={handleSearchChange}
              onKeyDown={handleSearchKeyDown}
              onBlur={handleSearchBlur}
              {...clearSearch}
            />
          ) : (
            <>
              <Text as="span" className={styles.sectionLabel}>
                Fleet
              </Text>
              <button
                ref={searchToggleRef}
                type="button"
                className={styles.favoriteManage}
                aria-label="Search sessions"
                title="Search sessions, nodes and projects"
                aria-expanded={false}
                onClick={handleOpenSearch}
              >
                <Search20Regular aria-hidden="true" />
              </button>
            </>
          )}
          <span className={styles.visuallyHidden} role="status" aria-live="polite">
            {searching
              ? matchCount === 0
                ? "No matches"
                : `${matchCount} ${matchCount === 1 ? "match" : "matches"}`
              : ""}
          </span>
        </div>
        {searching && matchCount === 0 && (
          <p className={styles.empty}>
            No sessions, nodes or projects match “{query.trim()}”.
          </p>
        )}
        {showFavorites && (
          <div className={styles.favoriteHeader}>
            {searching ? (
              <Text
                as="span"
                className={mergeClasses(styles.sectionLabel, styles.sectionHeading)}
              >
                <Star20Filled aria-hidden="true" />
                <span>Favorites</span>
              </Text>
            ) : (
              <button
                type="button"
                className={mergeClasses(styles.sectionLabel, styles.sectionDisclosure)}
                aria-expanded={!favoritesClosed}
                aria-label={favoritesClosed ? "Show favorites" : "Hide favorites"}
                onClick={() => setFavoritesClosed((closed) => !closed)}
              >
                {favoritesClosed ? (
                  <ChevronRight20Regular aria-hidden="true" />
                ) : (
                  <ChevronDown20Regular aria-hidden="true" />
                )}
                <Star20Filled aria-hidden="true" />
                <span>Favorites</span>
              </button>
            )}
            <button
              type="button"
              className={styles.favoriteManage}
              aria-label="Manage favorites"
              title="Manage favorites"
              onClick={onManageFavorites}
            >
              <MoreHorizontal20Regular aria-hidden="true" />
            </button>
          </div>
        )}
        {showFavorites &&
          favoritesOpen &&
          (visibleFavorites.length > 0 ? (
            visibleFavorites.map((favorite) => {
              const lead = favorite.runRole === "lead";
              return (
                <div className={styles.favoriteEntry} key={`favorite:${favorite.id}`}>
                  <button
                    type="button"
                    className={styles.favoriteLink}
                    title={sessionLabel(favorite)}
                    data-search-result
                    onClick={() =>
                      lead
                        ? onSelectLeadSession(favorite.id)
                        : onSelectSession(favorite.id)
                    }
                  >
                    {lead && <Chat20Regular aria-hidden="true" />}
                    <StatusIndicator
                      descriptor={sessionStatusDescriptor(
                        favorite,
                        waitingPermissions.some(
                          (event) => event.sessionId === favorite.id,
                        ),
                      )}
                      variant="icon"
                    />
                    <span className={styles.sessionName}>
                      <HighlightedText text={sessionLabel(favorite)} terms={terms} />
                    </span>
                  </button>
                </div>
              );
            })
          ) : (
            <p className={styles.empty}>No favorites yet.</p>
          ))}
        {/*
          The orchestrator sits above the workspaces rather than inside one.
          It is the fleet-wide surface — the session you brief, and the work it
          has out on every machine — so nesting it under a repository would
          both bury it and imply it belongs to that repository.
        */}
        {/*
          Two controls, side by side, rather than one inside the other: a
          button nested in a button is invalid, and the outer row ended up
          announcing itself as "Hide conversations Orchestrator".

          While searching, the row shows only when a conversation matched, as
          the heading those matches sit under; the fold is not offered because
          the matches are held open.
        */}
        {(!searching || visibleLeads.length > 0) && (
          <div
            className={mergeClasses(
              styles.orchestrationRow,
              (view === "orchestrator" || view === "orchestrator-task") &&
                styles.orchestrationActive,
            )}
          >
            {leadSessions.length > 0 && !searching && (
              <button
                type="button"
                className={styles.disclosure}
                aria-expanded={!conversationsClosed}
                aria-label={
                  conversationsClosed ? "Show conversations" : "Hide conversations"
                }
                title={conversationsClosed ? "Show conversations" : "Hide conversations"}
                onClick={() => setConversationsClosed((closed) => !closed)}
              >
                {conversationsClosed ? (
                  <ChevronRight20Regular aria-hidden="true" />
                ) : (
                  <ChevronDown20Regular aria-hidden="true" />
                )}
              </button>
            )}
            <button
              type="button"
              className={styles.orchestration}
              aria-current={view === "orchestrator" ? "page" : undefined}
              onClick={() => onSelectView("orchestrator")}
            >
              <Flow20Regular aria-hidden="true" />
              <span
                className={styles.orchestrationLabel}
                data-tour="orchestrator-navigation"
              >
                Orchestrator
              </span>
              {attentionCount > 0 && (
                <span
                  className={styles.attentionBadge}
                  title={`${attentionCount} waiting for you`}
                >
                  {attentionCount}
                </span>
              )}
              {liveWorkCount > 0 && (
                <span className={styles.orchestrationCount}>{liveWorkCount}</span>
              )}
            </button>
          </div>
        )}
        {/*
          A conversation belongs to the orchestrator, not to the workspace its
          process happens to run in. They are filtered out of the session tree
          for the same reason, so these are their only way in.
        */}
        {conversationsOpen &&
          visibleLeads.map((lead) => {
            const open = view === "session" && selectedSessionId === lead.id;
            return (
              <button
                key={lead.id}
                type="button"
                className={mergeClasses(
                  styles.leadRow,
                  open && styles.orchestrationActive,
                )}
                aria-current={open ? "page" : undefined}
                title={sessionLabel(lead)}
                data-search-result
                onClick={() => onSelectLeadSession(lead.id)}
              >
                <Chat20Regular aria-hidden="true" />
                <span className={styles.orchestrationLabel}>
                  <HighlightedText text={sessionLabel(lead)} terms={terms} />
                </span>
                <StatusIndicator
                  descriptor={sessionStatusDescriptor(
                    lead,
                    waitingPermissions.some((event) => event.sessionId === lead.id),
                  )}
                  variant="icon"
                />
              </button>
            );
          })}
        {leadSessions.length > 0 && !conversationsClosed && !searching && (
          <button
            type="button"
            className={styles.leadRow}
            title="Start another conversation with the orchestrator"
            onClick={onNewConversation}
          >
            <Add20Regular aria-hidden="true" />
            <span className={styles.orchestrationLabel}>New conversation</span>
          </button>
        )}
        {visibleDismissed.length > 0 && (
          <>
            {searching ? (
              <Text as="span" className={styles.sectionLabel}>
                Dismissed orchestrators
              </Text>
            ) : (
              <button
                type="button"
                className={mergeClasses(styles.sectionLabel, styles.sectionDisclosure)}
                aria-expanded={!dismissedClosed}
                aria-label={
                  dismissedClosed
                    ? "Show dismissed orchestrators"
                    : "Hide dismissed orchestrators"
                }
                onClick={() => setDismissedClosed((closed) => !closed)}
              >
                {dismissedClosed ? (
                  <ChevronRight20Regular aria-hidden="true" />
                ) : (
                  <ChevronDown20Regular aria-hidden="true" />
                )}
                <span>Dismissed orchestrators</span>
              </button>
            )}
            {dismissedOpen &&
              visibleDismissed.map((lead) => (
                <div className={styles.favoriteEntry} key={lead.id}>
                  <button
                    type="button"
                    className={styles.favoriteLink}
                    title={`Restore ${sessionLabel(lead)}`}
                    data-search-result
                    onClick={() => onRestoreLeadSession?.(lead.id)}
                  >
                    <Chat20Regular aria-hidden="true" />
                    <span className={styles.orchestrationLabel}>
                      <HighlightedText text={sessionLabel(lead)} terms={terms} />
                    </span>
                    <span>Restore</span>
                  </button>
                  <Button
                    appearance="subtle"
                    size="small"
                    icon={<Delete20Regular />}
                    aria-label={`Delete ${sessionLabel(lead)}`}
                    title={`Delete ${sessionLabel(lead)}`}
                    onClick={() => setDeleteLead(lead)}
                  />
                </div>
              ))}
          </>
        )}
        {(!searching || visibleGroups.length > 0) && (
          <Text as="span" className={styles.sectionLabel}>
            Agents
          </Text>
        )}
        {groups.length === 0 ? (
          searching ? null : (
            <p className={styles.empty}>No workspaces yet.</p>
          )
        ) : visibleGroups.length === 0 ? null : (
          <Tree
            aria-label="Sessions by workspace"
            openItems={openItems}
            onOpenChange={handleOpenChange}
          >
            {visibleGroups.map((group) => {
              // Chats is the fleet's own row rather than one of the operator's
              // projects: it cannot be reordered, and a checkout dropped on it
              // would be refused by the Host — so it does not offer either.
              const reserved = group.kind === "chats";
              // A chat checkout is the node's own home directory, written by the
              // Host from what that machine reports. There is nothing to refile
              // and nothing to reorder, so these rows offer no handle at all
              // rather than a drag the Host would then refuse.
              const movable = (nodeId: string) =>
                reserved ? undefined : placementFor(group.workspaceId, nodeId);
              return (
                <TreeItem
                  itemType="branch"
                  value={workspaceKey(group.workspaceId)}
                  key={group.workspaceId}
                >
                  <TreeItemLayout
                    iconBefore={reserved ? <Chat20Regular /> : <Folder20Regular />}
                    draggable={!reserved}
                    className={mergeClasses(
                      !reserved && styles.draggable,
                      dropTarget?.key === group.workspaceId &&
                        (dropTarget.edge === "before"
                          ? styles.dropBefore
                          : styles.dropAfter),
                    )}
                    title={
                      reserved
                        ? "Questions and research that need no checkout — each session runs in its node's home directory"
                        : `${group.workspaceName} — drag above or below another workspace to reorder`
                    }
                    onDragStart={(event: DragEvent<HTMLDivElement>) => {
                      if (reserved) return;
                      event.dataTransfer.setData(
                        DRAG_MIME,
                        encodeDrag({ kind: "workspace", id: group.workspaceId }),
                      );
                      event.dataTransfer.effectAllowed = "move";
                    }}
                    onDragOver={(event: DragEvent<HTMLDivElement>) => {
                      if (reserved) return;
                      if (!event.dataTransfer.types.includes(DRAG_MIME)) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      setDropTarget({
                        key: group.workspaceId,
                        edge: edgeFromPointer(
                          event.currentTarget.getBoundingClientRect(),
                          event.clientY,
                        ),
                      });
                    }}
                    onDragLeave={() => setDropTarget(undefined)}
                    onDrop={(event: DragEvent<HTMLDivElement>) => {
                      const edge = dropTarget?.edge ?? "before";
                      setDropTarget(undefined);
                      if (reserved) return;
                      const payload = decodeDrag(event.dataTransfer.getData(DRAG_MIME));
                      if (!payload) return;
                      event.preventDefault();
                      if (payload.kind === "workspace") {
                        void reorderWorkspaces(
                          reorder(
                            // Chats is pinned above the list by the Host and is
                            // not part of the order being described, so sending it
                            // back would ask for a move that is refused anyway.
                            workspaces
                              .filter((entry) => entry.kind !== "chats")
                              .map((entry) => entry.id),
                            payload.id,
                            group.workspaceId,
                            edge,
                          ),
                        );
                        return;
                      }
                      if (payload.kind !== "placement") return;
                      void updatePlacement(payload.id, {
                        workspaceId: group.workspaceId,
                      });
                    }}
                  >
                    <HighlightedText text={group.workspaceName} terms={terms} />
                  </TreeItemLayout>
                  <Tree>
                    {group.nodes.length === 0 ? (
                      <TreeItem
                        itemType="leaf"
                        value={`${workspaceKey(group.workspaceId)}:empty`}
                      >
                        <TreeItemLayout className={styles.offline}>
                          No sessions
                        </TreeItemLayout>
                      </TreeItem>
                    ) : (
                      group.nodes.map((nodeGroup) => (
                        <TreeItem
                          itemType="branch"
                          value={nodeKey(group.workspaceId, nodeGroup.nodeId)}
                          key={nodeGroup.nodeId}
                        >
                          <TreeItemLayout
                            iconBefore={<Server20Regular />}
                            // The node under a workspace is that workspace's
                            // checkout on that machine, so this row is the
                            // placement — drag it to file it elsewhere. A node
                            // left over from deleted history has no placement to
                            // move and stays put.
                            draggable={Boolean(movable(nodeGroup.nodeId))}
                            onDragStart={(event: DragEvent<HTMLDivElement>) => {
                              const placement = movable(nodeGroup.nodeId);
                              if (!placement) return;
                              event.dataTransfer.setData(
                                DRAG_MIME,
                                encodeDrag({ kind: "placement", id: placement.id }),
                              );
                              event.dataTransfer.effectAllowed = "move";
                            }}
                            title={
                              movable(nodeGroup.nodeId)
                                ? `${nodeGroup.nodeName} — drag onto a sibling to reorder, or onto another workspace to move`
                                : nodeGroup.nodeName
                            }
                            className={mergeClasses(
                              nodeGroup.online ? undefined : styles.offline,
                              movable(nodeGroup.nodeId) && styles.draggable,
                              dropTarget?.key ===
                                nodeKey(group.workspaceId, nodeGroup.nodeId) &&
                                (dropTarget.edge === "before"
                                  ? styles.dropBefore
                                  : styles.dropAfter),
                            )}
                            onDragOver={(event: DragEvent<HTMLDivElement>) => {
                              const target = movable(nodeGroup.nodeId);
                              if (!target) return;
                              if (!event.dataTransfer.types.includes(DRAG_MIME)) return;
                              event.preventDefault();
                              event.dataTransfer.dropEffect = "move";
                              // Stops the workspace row underneath from also
                              // showing a line, which would make it unclear where
                              // the item is going to land.
                              event.stopPropagation();
                              setDropTarget({
                                key: nodeKey(group.workspaceId, nodeGroup.nodeId),
                                edge: edgeFromPointer(
                                  event.currentTarget.getBoundingClientRect(),
                                  event.clientY,
                                ),
                              });
                            }}
                            onDragLeave={() => setDropTarget(undefined)}
                            onDrop={(event: DragEvent<HTMLDivElement>) => {
                              const edge = dropTarget?.edge ?? "before";
                              setDropTarget(undefined);
                              const target = movable(nodeGroup.nodeId);
                              const payload = decodeDrag(
                                event.dataTransfer.getData(DRAG_MIME),
                              );
                              if (!target || payload?.kind !== "placement") return;
                              event.preventDefault();
                              event.stopPropagation();
                              const siblings = placements
                                .filter(
                                  (entry) => entry.workspaceId === group.workspaceId,
                                )
                                .map((entry) => entry.id);
                              // Dropping a placement from another workspace onto
                              // a row here means "put it in this workspace", not
                              // "reorder"; the id is not among these siblings.
                              if (!siblings.includes(payload.id)) {
                                void updatePlacement(payload.id, {
                                  workspaceId: group.workspaceId,
                                });
                                return;
                              }
                              void reorderPlacements(
                                group.workspaceId,
                                reorder(siblings, payload.id, target.id, edge),
                              );
                            }}
                          >
                            <HighlightedText text={nodeGroup.nodeName} terms={terms} />
                          </TreeItemLayout>
                          <Tree>
                            {nodeGroup.sessions.map((session) => {
                              const isSelected =
                                view === "session" && session.id === selectedSessionId;
                              return (
                                <TreeItem
                                  itemType="leaf"
                                  value={session.id}
                                  key={session.id}
                                  ref={isSelected ? revealSelectedRow : undefined}
                                  aria-selected={isSelected}
                                  onClick={() => onSelectSession(session.id)}
                                  onKeyDown={handleSessionKeyDown(session.id)}
                                >
                                  <TreeItemLayout
                                    draggable
                                    className={mergeClasses(
                                      styles.row,
                                      styles.draggable,
                                      isSelected && styles.selectedRow,
                                      dropTarget?.key === session.id &&
                                        (dropTarget.edge === "before"
                                          ? styles.dropBefore
                                          : styles.dropAfter),
                                    )}
                                    onDragStart={(event: DragEvent<HTMLDivElement>) => {
                                      event.dataTransfer.setData(
                                        DRAG_MIME,
                                        encodeDrag({ kind: "session", id: session.id }),
                                      );
                                      event.dataTransfer.effectAllowed = "move";
                                    }}
                                    onDragOver={(event: DragEvent<HTMLDivElement>) => {
                                      if (!event.dataTransfer.types.includes(DRAG_MIME)) {
                                        return;
                                      }
                                      event.preventDefault();
                                      event.dataTransfer.dropEffect = "move";
                                      // Without this the node row above also
                                      // claims the drag, and the line appears in
                                      // the wrong place.
                                      event.stopPropagation();
                                      setDropTarget({
                                        key: session.id,
                                        edge: edgeFromPointer(
                                          event.currentTarget.getBoundingClientRect(),
                                          event.clientY,
                                        ),
                                      });
                                    }}
                                    onDragLeave={() => setDropTarget(undefined)}
                                    onDrop={(event: DragEvent<HTMLDivElement>) => {
                                      const edge = dropTarget?.edge ?? "before";
                                      setDropTarget(undefined);
                                      const payload = decodeDrag(
                                        event.dataTransfer.getData(DRAG_MIME),
                                      );
                                      if (payload?.kind !== "session") return;
                                      event.preventDefault();
                                      event.stopPropagation();
                                      // Every session on this node, not only the
                                      // ones a search left showing: the Host
                                      // numbers what it is sent from zero, so a
                                      // filtered list would collide with the
                                      // positions of the rows it left out.
                                      const siblings = (
                                        groups
                                          .find(
                                            (entry) =>
                                              entry.workspaceId === group.workspaceId,
                                          )
                                          ?.nodes.find(
                                            (entry) => entry.nodeId === nodeGroup.nodeId,
                                          )?.sessions ?? nodeGroup.sessions
                                      ).map((entry) => entry.id);
                                      // Sessions belong to the machine that runs
                                      // them, so one dragged from another node is
                                      // not something this list can accept.
                                      if (!siblings.includes(payload.id)) return;
                                      void reorderSessions(
                                        reorder(siblings, payload.id, session.id, edge),
                                      );
                                    }}
                                  >
                                    <span className={styles.sessionLabel}>
                                      <StatusIndicator
                                        descriptor={sessionStatusDescriptor(
                                          session,
                                          waitingPermissions.some(
                                            (event) => event.sessionId === session.id,
                                          ),
                                        )}
                                        variant="icon"
                                      />
                                      {session.runRole !== "" && (
                                        <span
                                          className={styles.dispatchedMark}
                                          role="img"
                                          aria-label="Dispatched by the orchestrator"
                                          title="Dispatched by the orchestrator"
                                        >
                                          <Flow16Regular />
                                        </span>
                                      )}
                                      <span
                                        className={styles.sessionName}
                                        /*
                                         * The agent joins the hover text rather
                                         * than the row: this list is the densest
                                         * thing on screen, and a badge here would
                                         * cost the name its width on every row to
                                         * say something true of almost none.
                                         */
                                        title={[
                                          sessionStatusLabel(session),
                                          customAgentName(session.configOptions),
                                          session.initialPrompt,
                                        ]
                                          .filter(Boolean)
                                          .join(" · ")}
                                      >
                                        <HighlightedText
                                          text={sessionLabel(session)}
                                          terms={terms}
                                        />
                                      </span>
                                    </span>
                                  </TreeItemLayout>
                                </TreeItem>
                              );
                            })}
                          </Tree>
                        </TreeItem>
                      ))
                    )}
                  </Tree>
                </TreeItem>
              );
            })}
          </Tree>
        )}
      </div>

      <div className={styles.footer}>
        <Button
          appearance="primary"
          icon={<Add20Regular />}
          onClick={onNewSession}
          data-tour="new-session"
        >
          New session
        </Button>
        {liveAgentCount > 0 && (
          <Button
            appearance="subtle"
            className={styles.navButton}
            icon={<Stop20Regular />}
            onClick={onStopAllAgents}
            title="Choose agents to stop across all workspaces"
          >
            Stop agents ({liveAgentCount})
          </Button>
        )}
        {cleanupOrchestratorCount > 0 && (
          <Button
            appearance="subtle"
            className={styles.navButton}
            icon={<Delete20Regular />}
            onClick={onCleanupOrchestrators}
            title="Move selected stopped orchestrators to Dismissed"
          >
            Clean up orchestrators ({cleanupOrchestratorCount})
          </Button>
        )}
        {endedCount > 0 && (
          <Button
            appearance="subtle"
            className={styles.navButton}
            icon={<Delete20Regular />}
            onClick={onClearEnded}
          >
            Clear ended ({endedCount})
          </Button>
        )}
        <Button
          appearance={view === "usage" ? "secondary" : "subtle"}
          className={styles.navButton}
          icon={<DataUsage20Regular aria-hidden="true" />}
          aria-current={view === "usage" ? "page" : undefined}
          onClick={() => onSelectView("usage")}
        >
          Usage
        </Button>
        <Button
          appearance={view === "settings" ? "secondary" : "subtle"}
          className={styles.navButton}
          icon={<Settings20Regular />}
          onClick={() => onSelectView("settings")}
        >
          Settings
        </Button>
      </div>
      <Dialog
        open={!!deleteLead}
        onOpenChange={(_, data) => {
          if (!data.open && !deletingLead) setDeleteLead(undefined);
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Delete dismissed orchestrator?</DialogTitle>
            <DialogContent>
              <p>
                Permanently delete {deleteLead && sessionLabel(deleteLead)} and its
                conversation transcript from Fleet? It will be removed from this list and
                cannot be restored.
              </p>
              <p>
                Task history, worker sessions and files on your nodes are not deleted.
              </p>
            </DialogContent>
            <DialogActions>
              <Button disabled={deletingLead} onClick={() => setDeleteLead(undefined)}>
                Cancel
              </Button>
              <Button
                appearance="primary"
                disabled={deletingLead}
                onClick={() => {
                  if (!deleteLead) return;
                  setDeletingLead(true);
                  void onDeleteLeadSession(deleteLead.id)
                    .then((ok) => {
                      if (ok) setDeleteLead(undefined);
                    })
                    .finally(() => setDeletingLead(false));
                }}
              >
                Delete orchestrator
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </nav>
  );
};
