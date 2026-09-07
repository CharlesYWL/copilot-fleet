import { execFile } from "node:child_process";

export async function copyClaimCode(
  code: string,
  platform = process.platform,
  env = process.env,
): Promise<boolean> {
  let command: string;
  let args: string[] = [];
  if (platform === "win32") {
    command = "clip.exe";
  } else if (platform === "darwin") {
    command = "pbcopy";
  } else if (platform === "linux" && env.WAYLAND_DISPLAY) {
    command = "wl-copy";
  } else if (platform === "linux" && env.DISPLAY) {
    command = "xclip";
    args = ["-selection", "clipboard"];
  } else {
    return false;
  }

  return new Promise((resolve) => {
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
  const url = options.development ? "http://127.0.0.1:5173" : options.publicUrl;
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
