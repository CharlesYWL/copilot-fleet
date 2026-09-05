import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { AuthGate } from "./AuthGate";
import { browserNavigation } from "../lib/auth";
import { fleetDarkTheme } from "../theme";

const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const show = () =>
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <AuthGate>
        <div>console</div>
      </AuthGate>
    </FluentProvider>,
  );

/**
 * The one sign-in a public origin can complete.
 *
 * An invitation link is opened wherever the invited person is, which for a
 * remote administrator is the tunnel URL — the exact place the loopback flow
 * cannot finish. If the device flow drops the invitation on the floor, that
 * person authenticates, is told they are not an administrator, and leaves the
 * inviting administrator nothing to approve.
 */
describe("AuthGate device sign-in with an invitation", () => {
  let assign: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    assign = vi
      .spyOn(browserNavigation, "assign")
      .mockImplementation(() => undefined) as ReturnType<typeof vi.spyOn>;
    window.history.replaceState({}, "", "/?invitation=invite-id.invite-secret");
  });

  afterEach(() => {
    window.history.replaceState({}, "", "/");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("carries the invitation into the device flow it starts", async () => {
    const starts: unknown[] = [];
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/auth/device/start")) {
        starts.push(JSON.parse(String(init?.body ?? "{}")));
        return answer({
          flowId: "flow-1",
          userCode: "ABC-DEF",
          verificationUri: "https://microsoft.com/devicelogin",
          message: "Enter ABC-DEF",
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        });
      }
      if (url.includes("/api/auth/device/poll")) {
        return answer({ error: "Waiting" }, 202);
      }
      return answer({
        state: "microsoft-only",
        authenticated: false,
        passwordEnabled: false,
        entraConfigured: true,
        deviceFlowEnabled: true,
        claimCodeRequired: false,
        canSignIn: true,
        // A public origin: the loopback flow cannot complete here.
        codeLogin: { available: false, localForwardRequired: true },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    show();

    const button = await screen.findByRole("button", { name: /device code/i });
    fireEvent.click(button);

    await waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]).toMatchObject({ invitation: "invite-id.invite-secret" });
    expect(assign).not.toHaveBeenCalled();
  });
});
