import { useState, type FormEvent } from "react";
import {
  Button,
  Field,
  Input,
  Select,
  Text,
  Textarea,
  Title3,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import {
  Checkmark20Regular,
  Delete20Regular,
  Dismiss20Regular,
  Rename20Regular,
} from "@fluentui/react-icons";
import type { FleetNode, Placement, Workspace } from "@fleet/protocol";
import { nextPlacementPath } from "../lib/placement-path.js";
import {
  DRAG_MIME,
  decodeDrag,
  dropVerdict,
  edgeFromPointer,
  encodeDrag,
  reorder,
  suggestedPath,
  type DropEdge,
  type DragPayload,
  type DropVerdict,
} from "../lib/drag-drop";
import { useCatalog } from "../hooks/useCatalog";
import { StatusDot } from "./StatusDot";

const useStyles = makeStyles({
  panel: {
    flexGrow: 1,
    overflowY: "auto",
    padding: "28px 32px",
  },
  head: {
    marginBottom: "20px",
  },
  caption: {
    color: tokens.colorNeutralForeground3,
  },
  columns: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "16px",
    "@media (max-width: 1000px)": {
      gridTemplateColumns: "1fr",
    },
  },
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    background: tokens.colorNeutralBackground1,
    padding: "20px",
  },
  cardTitle: {
    display: "block",
    marginBottom: "14px",
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  },
  submit: {
    alignSelf: "flex-end",
  },
  list: {
    display: "grid",
    gap: "12px",
    marginTop: "20px",
  },
  workspaceCard: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    background: tokens.colorNeutralBackground1,
    padding: "18px 20px",
    display: "flex",
    justifyContent: "space-between",
    gap: "24px",
    "@media (max-width: 1000px)": {
      flexDirection: "column",
    },
  },
  workspaceMeta: {
    minWidth: "220px",
    display: "grid",
    gap: "8px",
    alignContent: "start",
  },
  titleRow: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    minWidth: 0,
  },
  titleText: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  editFields: {
    display: "grid",
    gap: "8px",
  },
  placements: {
    minWidth: "55%",
    display: "grid",
    gap: "6px",
    alignContent: "start",
  },
  placementRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "12px",
    background: tokens.colorNeutralBackground4,
    borderRadius: tokens.borderRadiusMedium,
    padding: "8px 11px",
    fontSize: "12px",
  },
  placementInfo: {
    display: "grid",
    gap: "2px",
    minWidth: 0,
    flexGrow: 1,
  },
  mono: {
    fontFamily: '"JetBrains Mono", ui-monospace, monospace',
    color: tokens.colorNeutralForeground2,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: "2px",
    flexShrink: 0,
  },
  pathInput: {
    minWidth: "180px",
    width: "100%",
  },
  nodeTray: {
    display: "grid",
    gap: "8px",
    padding: "12px 14px",
    borderRadius: tokens.borderRadiusMedium,
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
  },
  nodeChips: {
    display: "flex",
    flexWrap: "wrap",
    gap: "8px",
  },
  nodeChip: {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    padding: "4px 10px",
    borderRadius: tokens.borderRadiusCircular,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    background: tokens.colorNeutralBackground4,
    fontSize: "12px",
    cursor: "grab",
    ":active": { cursor: "grabbing" },
  },
  dropAccept: {
    outline: `2px solid ${tokens.colorBrandStroke1}`,
    outlineOffset: "-1px",
  },
  dropReject: {
    outline: `2px solid ${tokens.colorPaletteRedBorder2}`,
    outlineOffset: "-1px",
  },
  dropHint: {
    color: tokens.colorPaletteRedForeground1,
    fontSize: "11px",
  },
  rowBefore: {
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
  rowAfter: {
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
});

type WorkspacesPanelProps = {
  workspaces: Workspace[];
  placements: Placement[];
  nodes: FleetNode[];
};

export const WorkspacesPanel = ({
  workspaces,
  placements,
  nodes,
}: WorkspacesPanelProps) => {
  const styles = useStyles();
  const { createWorkspace, createPlacement } = useCatalog();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [nodeId, setNodeId] = useState("");
  const [localPath, setLocalPath] = useState("");

  const handleSelectNode = (nextNodeId: string) => {
    const previousHome = nodes.find((node) => node.id === nodeId)?.homeDir;
    const nextHome = nodes.find((node) => node.id === nextNodeId)?.homeDir ?? "";
    setNodeId(nextNodeId);
    setLocalPath((current) => nextPlacementPath(current, previousHome, nextHome));
  };

  const handleCreateWorkspace = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    const created = await createWorkspace(name.trim(), description.trim());
    if (!created) return;
    setName("");
    setDescription("");
  };

  const handleCreatePlacement = async (event: FormEvent) => {
    event.preventDefault();
    if (!workspaceId || !nodeId || !localPath.trim()) return;
    const created = await createPlacement(workspaceId, nodeId, localPath.trim());
    if (!created) return;
    // The node stays selected, so reset to its home rather than to blank: the
    // next placement on the same machine starts from a usable path again.
    setLocalPath(nodes.find((node) => node.id === nodeId)?.homeDir ?? "");
  };

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <Title3 as="h1">Workspaces &amp; placements</Title3>
        <br />
        <Text className={styles.caption}>
          Map each logical project to its machine-local absolute path.
        </Text>
      </div>

      <div className={styles.columns}>
        <section className={styles.card}>
          <Text weight="semibold" className={styles.cardTitle}>
            Create workspace
          </Text>
          <form className={styles.form} onSubmit={handleCreateWorkspace}>
            <Field label="Name" required>
              <Input
                value={name}
                onChange={(_event, data) => setName(data.value)}
                placeholder="checkout-service"
              />
            </Field>
            <Field label="Description">
              <Textarea
                value={description}
                onChange={(_event, data) => setDescription(data.value)}
                resize="vertical"
              />
            </Field>
            <Button
              appearance="primary"
              type="submit"
              className={styles.submit}
              disabled={name.trim().length === 0}
            >
              Create
            </Button>
          </form>
        </section>

        <section className={styles.card}>
          <Text weight="semibold" className={styles.cardTitle}>
            Add placement
          </Text>
          <form className={styles.form} onSubmit={handleCreatePlacement}>
            <Field label="Workspace" required>
              <Select
                value={workspaceId}
                onChange={(_event, data) => setWorkspaceId(data.value)}
              >
                <option value="">Select a workspace</option>
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Node" required>
              <Select
                value={nodeId}
                onChange={(_event, data) => handleSelectNode(data.value)}
              >
                <option value="">Select a node</option>
                {nodes.map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Absolute local path" required>
              <Input
                value={localPath}
                onChange={(_event, data) => setLocalPath(data.value)}
                placeholder="C:\code\project or /srv/project"
              />
            </Field>
            <Button
              appearance="primary"
              type="submit"
              className={styles.submit}
              disabled={!workspaceId || !nodeId || localPath.trim().length === 0}
            >
              Add placement
            </Button>
          </form>
        </section>
      </div>

      <div className={styles.list}>
        <section className={styles.nodeTray} aria-label="Nodes">
          <Text className={styles.caption}>
            Drag a node onto a workspace to place it, or drag a placement between
            workspaces to move it.
          </Text>
          <div className={styles.nodeChips}>
            {nodes.map((node) => (
              <span
                key={node.id}
                className={styles.nodeChip}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData(
                    DRAG_MIME,
                    encodeDrag({ kind: "node", id: node.id }),
                  );
                  event.dataTransfer.effectAllowed = "copy";
                }}
                title={`${node.name} — drag onto a workspace`}
              >
                <StatusDot state={node.online ? "idle" : "offline"} />
                {node.name}
              </span>
            ))}
          </div>
        </section>
        {workspaces.map((workspace) => (
          <WorkspaceCard
            key={workspace.id}
            workspace={workspace}
            placements={placements.filter(
              (placement) => placement.workspaceId === workspace.id,
            )}
            allPlacements={placements}
            nodes={nodes}
          />
        ))}
      </div>
    </div>
  );
};

type WorkspaceCardProps = {
  workspace: Workspace;
  placements: Placement[];
  /** Every placement, not just this card's: the rules need the whole picture. */
  allPlacements: Placement[];
  nodes: FleetNode[];
};

const WorkspaceCard = ({
  workspace,
  placements,
  allPlacements,
  nodes,
}: WorkspaceCardProps) => {
  const styles = useStyles();
  const [dropState, setDropState] = useState<"accept" | "reject">();
  const [dropHint, setDropHint] = useState<string>();
  const {
    updateWorkspace,
    deleteWorkspace,
    updatePlacement,
    deletePlacement,
    createPlacement,
    reorderPlacements,
  } = useCatalog();
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(workspace.name);
  const [draftDescription, setDraftDescription] = useState(workspace.description);

  const handleStartEdit = () => {
    setDraftName(workspace.name);
    setDraftDescription(workspace.description);
    setEditing(true);
  };

  const handleSave = async () => {
    const name = draftName.trim();
    if (!name) return;
    if (name === workspace.name && draftDescription === workspace.description) {
      setEditing(false);
      return;
    }
    if (await updateWorkspace(workspace.id, name, draftDescription)) {
      setEditing(false);
    }
  };

  const handleDelete = () => {
    if (
      !window.confirm(
        `Delete workspace "${workspace.name}"? Its placements and finished sessions will be removed.`,
      )
    ) {
      return;
    }
    void deleteWorkspace(workspace.id);
  };

  const clearDrop = () => {
    setDropState(undefined);
    setDropHint(undefined);
  };

  /** The rules, applied to whatever the browser says is being dragged. */
  const verdictFor = (event: { dataTransfer: DataTransfer }): DropVerdict | undefined => {
    // `getData` is empty during dragover in every browser, by design, so the
    // check has to be that our own type is on the list.
    if (!event.dataTransfer.types.includes(DRAG_MIME)) return undefined;
    const payload = decodeDrag(event.dataTransfer.getData(DRAG_MIME));
    // During dragover the payload is unreadable; the card still has to say
    // something, and "this target takes fleet items" is the honest answer until
    // the drop makes the details available.
    if (!payload) return { allowed: true, action: "move" };
    return dropVerdict(payload, workspace, allPlacements, nodes);
  };

  const handleDrop = async (payload: DragPayload) => {
    if (payload.kind === "placement") {
      await updatePlacement(payload.id, { workspaceId: workspace.id });
      return;
    }
    const node = nodes.find((entry) => entry.id === payload.id);
    if (!node) return;
    await createPlacement(workspace.id, node.id, suggestedPath(node));
  };

  return (
    <article
      className={mergeClasses(
        styles.workspaceCard,
        dropState === "accept" && styles.dropAccept,
        dropState === "reject" && styles.dropReject,
      )}
      onDragOver={(event) => {
        const verdict = verdictFor(event);
        if (!verdict) return;
        // Both outcomes preventDefault: a rejected drop has to land here to be
        // explained, rather than falling through to the browser's own handler.
        event.preventDefault();
        event.dataTransfer.dropEffect = verdict.allowed ? "move" : "none";
        setDropState(verdict.allowed ? "accept" : "reject");
        setDropHint(verdict.allowed ? undefined : verdict.reason);
      }}
      onDragLeave={(event) => {
        // Moving across a child fires dragleave on the card; only a pointer
        // that has actually left the card should clear the highlight.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        clearDrop();
      }}
      onDrop={(event) => {
        const verdict = verdictFor(event);
        clearDrop();
        if (!verdict) return;
        event.preventDefault();
        if (!verdict.allowed) return;
        void handleDrop(decodeDrag(event.dataTransfer.getData(DRAG_MIME))!);
      }}
    >
      {dropHint ? (
        <Text className={styles.dropHint} role="status">
          {dropHint}
        </Text>
      ) : null}
      <div className={styles.workspaceMeta}>
        {editing ? (
          <div className={styles.editFields}>
            <Input
              value={draftName}
              aria-label="Workspace name"
              onChange={(_event, data) => setDraftName(data.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleSave();
                if (event.key === "Escape") setEditing(false);
              }}
            />
            <Textarea
              value={draftDescription}
              aria-label="Workspace description"
              resize="vertical"
              onChange={(_event, data) => setDraftDescription(data.value)}
            />
            <span className={styles.actions}>
              <Button
                appearance="subtle"
                size="small"
                icon={<Checkmark20Regular />}
                aria-label="Save workspace"
                onClick={() => void handleSave()}
              />
              <Button
                appearance="subtle"
                size="small"
                icon={<Dismiss20Regular />}
                aria-label="Cancel edit"
                onClick={() => setEditing(false)}
              />
            </span>
          </div>
        ) : (
          <>
            <span className={styles.titleRow}>
              <Text weight="semibold" className={styles.titleText}>
                {workspace.name}
              </Text>
              <Button
                appearance="subtle"
                size="small"
                icon={<Rename20Regular />}
                aria-label="Edit workspace"
                title="Edit workspace"
                onClick={handleStartEdit}
              />
              <Button
                appearance="subtle"
                size="small"
                icon={<Delete20Regular />}
                aria-label="Delete workspace"
                title="Delete workspace"
                onClick={handleDelete}
              />
            </span>
            <Text className={styles.caption}>
              {workspace.description || "No description"}
            </Text>
          </>
        )}
      </div>
      <div className={styles.placements}>
        {placements.length === 0 ? (
          <Text className={styles.caption}>No placements yet</Text>
        ) : (
          placements.map((placement) => (
            <PlacementRow
              key={placement.id}
              placement={placement}
              onUpdate={updatePlacement}
              onDelete={deletePlacement}
              onReorderOnto={(draggedId, edge) =>
                void reorderPlacements(
                  workspace.id,
                  reorder(
                    placements.map((entry) => entry.id),
                    draggedId,
                    placement.id,
                    edge,
                  ),
                )
              }
            />
          ))
        )}
      </div>
    </article>
  );
};

type PlacementRowProps = {
  placement: Placement;
  onUpdate: (
    placementId: string,
    changes: { localPath?: string; workspaceId?: string },
  ) => Promise<boolean>;
  onDelete: (placementId: string) => Promise<boolean>;
  /** Called when a sibling is dropped on this row, to put it here. */
  onReorderOnto: (draggedPlacementId: string, edge: DropEdge) => void;
};

const PlacementRow = ({
  placement,
  onUpdate,
  onDelete,
  onReorderOnto,
}: PlacementRowProps) => {
  const styles = useStyles();
  const [draft, setDraft] = useState<string>();
  const [over, setOver] = useState<DropEdge>();

  if (draft === undefined) {
    return (
      <div
        className={mergeClasses(
          styles.placementRow,
          over === "before" && styles.rowBefore,
          over === "after" && styles.rowAfter,
        )}
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData(
            DRAG_MIME,
            encodeDrag({ kind: "placement", id: placement.id }),
          );
          event.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes(DRAG_MIME)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          // Without this the card behind also treats the drag as a drop onto
          // the workspace, and the row's own reorder never happens.
          event.stopPropagation();
          setOver(
            edgeFromPointer(event.currentTarget.getBoundingClientRect(), event.clientY),
          );
        }}
        onDragLeave={() => setOver(undefined)}
        onDrop={(event) => {
          const edge = over ?? "before";
          setOver(undefined);
          const payload = decodeDrag(event.dataTransfer.getData(DRAG_MIME));
          if (payload?.kind !== "placement" || payload.id === placement.id) return;
          event.preventDefault();
          event.stopPropagation();
          onReorderOnto(payload.id, edge);
        }}
        title={`${placement.nodeName} — drag onto another row to reorder`}
      >
        <div className={styles.placementInfo}>
          <Text weight="semibold">{placement.nodeName}</Text>
          <code className={styles.mono}>{placement.localPath}</code>
        </div>
        <span className={styles.actions}>
          <Button
            appearance="subtle"
            size="small"
            icon={<Rename20Regular />}
            aria-label="Edit path"
            title="Edit path"
            onClick={() => setDraft(placement.localPath)}
          />
          <Button
            appearance="subtle"
            size="small"
            icon={<Delete20Regular />}
            aria-label="Delete placement"
            title="Delete placement"
            onClick={() => {
              if (
                !window.confirm(
                  `Remove placement on ${placement.nodeName}? Finished sessions for it will be deleted.`,
                )
              ) {
                return;
              }
              void onDelete(placement.id);
            }}
          />
        </span>
      </div>
    );
  }

  const commit = async () => {
    const localPath = draft.trim();
    if (!localPath) return;
    if (
      localPath !== placement.localPath &&
      !(await onUpdate(placement.id, { localPath }))
    ) {
      return;
    }
    setDraft(undefined);
  };

  return (
    <div className={styles.placementRow}>
      <div className={styles.placementInfo}>
        <Text weight="semibold">{placement.nodeName}</Text>
        <Input
          className={styles.pathInput}
          size="small"
          value={draft}
          autoFocus
          aria-label={`Path for ${placement.nodeName}`}
          onChange={(_event, data) => setDraft(data.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void commit();
            if (event.key === "Escape") setDraft(undefined);
          }}
        />
      </div>
      <span className={styles.actions}>
        <Button
          appearance="subtle"
          size="small"
          icon={<Checkmark20Regular />}
          aria-label="Save path"
          onClick={() => void commit()}
        />
        <Button
          appearance="subtle"
          size="small"
          icon={<Dismiss20Regular />}
          aria-label="Cancel path edit"
          onClick={() => setDraft(undefined)}
        />
      </span>
    </div>
  );
};
