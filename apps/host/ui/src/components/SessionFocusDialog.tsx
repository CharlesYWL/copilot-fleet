import { Dialog, DialogSurface, makeStyles, tokens } from "@fluentui/react-components";
import type { FleetSession, SessionEvent } from "@fleet/protocol";
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
  events: SessionEvent[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPrompt: (prompt: string) => void;
  onCancel: () => void;
  onStop: () => void;
  onPermission: (
    requestId: string,
    outcome: "allow_once" | "deny",
    optionId?: string,
  ) => void;
};

export const SessionFocusDialog = ({
  session,
  events,
  open,
  onOpenChange,
  onPrompt,
  onCancel,
  onStop,
  onPermission,
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
          events={events}
          onPrompt={onPrompt}
          onCancel={onCancel}
          onStop={onStop}
          onPermission={onPermission}
          onClose={handleClose}
        />
      </DialogSurface>
    </Dialog>
  );
};
