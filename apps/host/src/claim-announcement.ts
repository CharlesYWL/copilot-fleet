import { execFile } from "node:child_process";

export async function copyClaimCode(
  code: string,
  platform = process.platform,
  env = process.env,
): Promise<boolean> {
  const backends: { command: string; args: string[] }[] = [];
  if (platform === "win32") {
    backends.push({ command: "clip.exe", args: [] });
  } else if (platform === "darwin") {
    backends.push({ command: "pbcopy", args: [] });
  } else if (platform === "linux") {
    if (env.WAYLAND_DISPLAY) backends.push({ command: "wl-copy", args: [] });
    if (env.DISPLAY) {
      backends.push({ command: "xclip", args: ["-selection", "clipboard"] });
    }
  }

  for (const { command, args } of backends) {
    const copied = await new Promise<boolean>((resolve) => {
      // Send the secret over stdin, never through a shell or process arguments.
      const child = execFile(
        command,
        args,
        { timeout: 2_000, windowsHide: true },
        (error) => resolve(!error),
      );
      child.stdin?.on("error", () => resolve(false));
      child.stdin?.end(code);
    });
    if (copied) return true;
  }
  return false;
}

export async function announceClaimCode(
  code: string,
  options: {
    development: boolean;
    publicUrl: string;
    write?: (message: string) => void;
    copy?: (code: string) => Promise<boolean>;
  },
): Promise<void> {
  const url = options.development ? "http://localhost:5173" : options.publicUrl;
  // Keep both the code and clipboard output out of the HTTP-visible log buffer.
  const write = options.write ?? ((message) => process.stdout.write(message));
  write(
    `\nCopilot Fleet is unclaimed. Claim it at ${url} with this one-time code:\n\n    ${code}\n\nIt expires in 30 minutes.\n\n`,
  );
  let copied = false;
  try {
    copied = await (options.copy ?? copyClaimCode)(code);
  } catch {
    // Clipboard access is best-effort; a headless Host still needs to start.
  }
  write(
    copied
      ? "Claim code copied to clipboard. Paste it into the claim form.\n\n"
      : "Clipboard unavailable. Copy the claim code above manually.\n\n",
  );
}
