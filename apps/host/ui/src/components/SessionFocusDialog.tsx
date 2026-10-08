import { Dialog, DialogSurface, makeStyles, tokens } from "@fluentui/react-components";
import type { ReactNode } from "react";
import type {
  FleetNode,
  FleetSession,
  Placement,
  PromptAttachment,
  SessionEvent,
} from "@fleet/protocol";
import type { SessionDraft } from "../lib/session-drafts";
import type { TranscriptActivity, TranscriptView } from "../hooks/useFleet";
import { TerminalView } from "./TerminalView";

const useStyles = makeStyles({
  // The surface hosts a full terminal, so it drops the dialog's default
  // padding and 600px cap and becomes a flex column instead.
  surface: {
    width: "min(1180px, 94vw)",
    maxWidth: "none",
    height: "min(860px, 88vh)",
    padding: 0,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
});

type SessionFocusDialogProps = {
  session: FleetSession;
  node?: FleetNode | undefined;
  placement?: Placement | undefined;
  transcript?: TranscriptView | undefined;
  onLoadOlder?: ((toIndex?: number) => Promise<void>) | undefined;
  activity?: TranscriptActivity | undefined;
  pendingPermission?: SessionEvent | null | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPrompt: (
    prompt: string,
    attachments?: PromptAttachment[],
    handback?: "ongoing" | "after_turn",
  ) => Promise<boolean>;
  maintenanceWorker?: boolean | undefined;
  onCancel: () => void;
  onStop: () => void;
  onDismiss: () => void;
  onResume: () => void;
  onRename: (name: string) => void;
  onPermission: (
    requestId: string,
    outcome: "allow_once" | "deny",
    optionId?: string,
  ) => void;
  onConfigChange: (configId: string, value: string) => void;
  notificationPreferenceControl?: ReactNode;
  messageQueue?: ReactNode;
  draft: SessionDraft;
  onDraftChange: (update: (current: SessionDraft) => SessionDraft) => void;
};

export const SessionFocusDialog = ({
  session,
  node,
  placement,
  transcript,
  onLoadOlder,
  activity,
  pendingPermission,
  open,
  onOpenChange,
  onPrompt,
  maintenanceWorker,
  onCancel,
  onStop,
  onDismiss,
  onResume,
  onRename,
  onPermission,
  onConfigChange,
  notificationPreferenceControl,
  messageQueue,
  draft,
  onDraftChange,
}: SessionFocusDialogProps) => {
  const styles = useStyles();
  const handleClose = () => onOpenChange(false);

  return (
    <Dialog
      open={open}
      onOpenChange={(_event, data) => onOpenChange(data.open)}
      modalType="modal"
    >
      <DialogSurface className={styles.surface}>
        <TerminalView
          session={session}
          node={node}
          placement={placement}
          transcript={transcript}
          onLoadOlder={onLoadOlder}
          activity={activity}
          pendingPermission={pendingPermission}
          onPrompt={onPrompt}
          maintenanceWorker={maintenanceWorker}
          onCancel={onCancel}
          onStop={onStop}
          onDismiss={onDismiss}
          onResume={onResume}
          onRename={onRename}
          onPermission={onPermission}
          onConfigChange={onConfigChange}
          notificationPreferenceControl={notificationPreferenceControl}
          messageQueue={messageQueue}
          onClose={handleClose}
          draft={draft}
          onDraftChange={onDraftChange}
        />
      </DialogSurface>
    </Dialog>
  );
};
