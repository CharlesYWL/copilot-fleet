import { vi } from "vitest";
import type * as claimAnnouncement from "./claim-announcement.js";

// Ordinary server fixtures must never overwrite the developer's OS clipboard.
// Clipboard-specific tests opt out and mock the child-process boundary instead.
vi.mock("./claim-announcement.js", async (importOriginal) => {
  const actual = await importOriginal<typeof claimAnnouncement>();
  return {
    ...actual,
    announceClaimCode: (
      code: string,
      options: Parameters<typeof actual.announceClaimCode>[1],
    ) =>
      actual.announceClaimCode(code, {
        ...options,
        copy: options.copy ?? (async () => false),
      }),
  };
});
