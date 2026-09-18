import { Button, Text } from "@fluentui/react-components";
import {
  isExactScriptPermissionKey,
  type CommandDecision,
  type CommandExecution,
} from "@fleet/protocol";
import { visibleCommandText } from "../lib/command-output";
import { ApiError } from "../hooks/useFleet";

export function isCommandApprovalConflict(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    [error.message, error.body.code, error.body.error, error.body.message].includes(
      "approval_conflict",
    )
  );
}

export function CommandApprovalActions({
  execution,
  disabled,
  onDecide,
}: {
  execution: CommandExecution;
  disabled: boolean;
  onDecide: (decision: CommandDecision["decision"]) => void;
}) {
  const permission = execution.descriptor?.prepared.permission;
  const exactScript =
    !!permission?.commandKey && isExactScriptPermissionKey(permission.commandKey);
  const commandLabel = exactScript
    ? "Exact script"
    : permission?.commandKey?.replace(/ @sha256:[a-f0-9]{64}$/, "");
  const pinned = !exactScript && commandLabel !== permission?.commandKey;
  return (
    <>
      <div style={{ flexBasis: "100%", marginBottom: 8 }}>
        {permission?.reusable && commandLabel ? (
          <Text>
            Remember{" "}
            <strong title={permission.commandKey}>
              {visibleCommandText(commandLabel)}
            </strong>{" "}
            in <strong>{visibleCommandText(permission.path)}</strong> on{" "}
            {execution.nodeName}.{" "}
            {exactScript
              ? "Only the complete script exactly as shown is covered; changing any text, including flags, asks again. Called tools and files may change between runs."
              : "Recognized ordinary flags can change; other commands and folders still ask."}{" "}
            Session access ends when this Orchestrator session stops or the Node restarts.
            Always allow saves a rule on the Node until you remove it.
            {pinned && " Updating or replacing the executable requires fresh approval."}
          </Text>
        ) : (
          <Text>
            {permission?.explanation || "This request supports one-time approval only."}{" "}
            No reusable permission will be created.
          </Text>
        )}
        {"placementId" in execution.target && permission && (
          <p>
            Ordinary workspace commands can run alongside sessions. Coordinate file
            changes with other work; managed task worktrees and maintenance remain
            protected.
          </p>
        )}
      </div>
      <Button
        appearance="primary"
        disabled={disabled}
        onClick={() => onDecide("allow_once")}
      >
        Allow once
      </Button>
      <Button
        disabled={disabled || !permission?.reusable}
        onClick={() => onDecide("allow_session")}
      >
        Allow during session
      </Button>
      <Button
        disabled={disabled || !permission?.reusable}
        onClick={() => onDecide("allow_always")}
      >
        Always allow on this Node
      </Button>
      <Button disabled={disabled} onClick={() => onDecide("deny")}>
        Deny
      </Button>
    </>
  );
}
