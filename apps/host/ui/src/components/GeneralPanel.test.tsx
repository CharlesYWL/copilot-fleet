import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { GeneralPanel } from "./GeneralPanel";
import { fleetDarkTheme } from "../theme";

const answer = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/**
 * Two archives, two meanings.
 *
 * The version 1 file carries workspaces, sessions and transcripts and
 * deliberately leaves the security envelope of whatever machine it lands on
 * alone. Calling it "move this Host" is how an operator ends up on a new
 * machine with their data and none of their administrators, wondering why they
 * cannot sign in.
 */
describe("GeneralPanel backup copy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("names the fleet archive as data only and points at the portable one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        answer({ yolo: false, autoResume: false, model: "", reasoningEffort: "" }),
      ),
    );
    render(
      <FluentProvider theme={fleetDarkTheme}>
        <GeneralPanel sessions={[]} />
      </FluentProvider>,
    );

    const card = await screen.findByRole("region", { name: /fleet data/i });
    expect(within(card).getByText(/does not carry/i)).toBeTruthy();
    expect(within(card).getByText(/settings → security/i)).toBeTruthy();
    expect(within(card).getByRole("button", { name: /export fleet data/i })).toBeTruthy();
  });
});
