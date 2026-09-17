import {
  COMMAND_LIMITS,
  type CommandExecution,
  type CommandOutputEvent,
} from "@fleet/protocol";

export function mergeCommandExecutions(
  ...groups: readonly (readonly CommandExecution[])[]
): CommandExecution[] {
  const records = new Map<string, CommandExecution>();
  for (const group of groups) {
    for (const item of group) {
      const prior = records.get(item.id);
      if (
        !prior ||
        item.version > prior.version ||
        (item.version === prior.version && item.updatedAt >= prior.updatedAt)
      ) {
        records.set(item.id, item);
      }
    }
  }
  return [...records.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function mergeCommandOutput(
  existing: readonly CommandOutputEvent[],
  incoming: readonly CommandOutputEvent[],
  maxBytes = COMMAND_LIMITS.queueBytes,
): CommandOutputEvent[] {
  const seen = new Set<string>();
  const result: CommandOutputEvent[] = [];
  let bytes = 0;
  for (const event of [...existing, ...incoming]) {
    const key = `${event.executionId}:${event.attemptId}:${event.sequence}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(event);
    bytes += event.data.length + 256;
  }
  let dropped = 0;
  while (bytes > maxBytes && dropped < result.length) {
    bytes -= result[dropped]!.data.length + 256;
    dropped += 1;
  }
  return result.slice(dropped);
}

/** Show directional and terminal controls instead of letting them disguise approved text. */
export function visibleCommandText(value: string): string {
  return value.replace(
    // eslint-disable-next-line no-control-regex -- Approval views must expose terminal and bidi controls.
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function decodeCommandOutput(
  events: readonly CommandOutputEvent[],
  complete = false,
): { text: string; lossy: boolean; gap: boolean; truncated: boolean } {
  const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  const strict = {
    stdout: new TextDecoder("utf-8", { fatal: true }),
    stderr: new TextDecoder("utf-8", { fatal: true }),
  };
  let text = "";
  let lossy = false;
  let gap = false;
  let previous = 0;
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    if (event.sequence > previous + 1) {
      text += `\n[Output gap: ${previous + 1}-${event.sequence - 1}]\n`;
      for (const stream of ["stdout", "stderr"] as const) {
        text += decoders[stream].decode();
        strict[stream] = new TextDecoder("utf-8", { fatal: true });
      }
      gap = true;
    }
    previous = event.sequence;
    const bytes = Uint8Array.from(atob(event.data), (character) =>
      character.charCodeAt(0),
    );
    try {
      strict[event.stream].decode(bytes, { stream: true });
    } catch {
      lossy = true;
      strict[event.stream] = new TextDecoder("utf-8", { fatal: true });
    }
    text += decoders[event.stream].decode(bytes, { stream: true });
  }
  if (complete) {
    for (const stream of ["stdout", "stderr"] as const) {
      text += decoders[stream].decode();
      try {
        strict[stream].decode();
      } catch {
        lossy = true;
      }
    }
  }
  const visible = visibleCommandText(text);
  const truncated = visible.length > COMMAND_LIMITS.pageBytes;
  return {
    text: truncated
      ? `[Earlier loaded output omitted from display]\n${visible.slice(-COMMAND_LIMITS.pageBytes)}`
      : visible,
    lossy,
    gap,
    truncated,
  };
}
