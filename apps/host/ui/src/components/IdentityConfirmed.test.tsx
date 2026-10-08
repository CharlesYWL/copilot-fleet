import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { IdentityConfirmed } from "./IdentityConfirmed";
import { onIdentityConfirmed } from "../lib/auth";
import { fleetDarkTheme } from "../theme";

const show = () =>
  render(
    <StrictMode>
      <FluentProvider theme={fleetDarkTheme}>
        <IdentityConfirmed />
      </FluentProvider>
    </StrictMode>,
  );

beforeEach(() => {
  window.history.replaceState({}, "", "/?reauthenticated=1#settings");
});

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/");
});

describe("IdentityConfirmed", () => {
  it("hands the sign-in back to the waiting tab and closes itself", async () => {
    const close = vi.spyOn(window, "close").mockImplementation(() => undefined);
    const waiting = vi.fn(() => true);
    const stop = onIdentityConfirmed(waiting);
    try {
      show();
      expect(screen.getByText(/returning to the tab you came from/i)).toBeTruthy();
      expect(
        await screen.findByRole("heading", { name: "Identity confirmed" }),
      ).toBeTruthy();
      expect(screen.getByText(/finishing in the tab you came from/i)).toBeTruthy();
      expect(waiting).toHaveBeenCalled();
      expect(close).toHaveBeenCalled();
      // A reload of this tab must not look like a second hand-back.
      expect(window.location.search).toBe("");
      expect(window.location.hash).toBe("#settings");
      expect(
        screen.getByRole("link", { name: /return to fleet/i }).getAttribute("href"),
      ).toBe("/");
    } finally {
      stop();
    }
  });

  it("says where to go when no tab was waiting for it", async () => {
    const close = vi.spyOn(window, "close").mockImplementation(() => undefined);
    show();

    expect(
      await screen.findByRole(
        "heading",
        { name: "Identity confirmed" },
        { timeout: 4_000 },
      ),
    ).toBeTruthy();
    expect(screen.getByText(/return to the tab you started from/i)).toBeTruthy();
    expect(screen.getByText(/within ten minutes/i)).toBeTruthy();
    expect(close).not.toHaveBeenCalled();
  });
});
