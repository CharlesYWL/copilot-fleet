import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { MicrosoftSignInSetupGuide } from "./MicrosoftSignInSetupGuide";
import { fleetDarkTheme } from "../../theme";

const show = (audience?: "public" | "enterprise") =>
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <MicrosoftSignInSetupGuide {...(audience ? { audience } : {})} />
    </FluentProvider>,
  );

describe("MicrosoftSignInSetupGuide", () => {
  it("provides official personal and corporate setup links in safe new tabs", () => {
    show();
    fireEvent.click(screen.getByText("First-time setup: personal or corporate account"));

    const links = [
      ["Open Microsoft Entra admin center", "https://entra.microsoft.com"],
      [
        "Personal-account client ID setup guide",
        "https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app",
      ],
      [
        "Corporate client ID setup guide",
        "https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app",
      ],
      [
        "Find your corporate tenant ID",
        "https://learn.microsoft.com/en-us/entra/fundamentals/how-to-find-tenant",
      ],
      [
        "directory setup and eligibility",
        "https://learn.microsoft.com/en-us/entra/fundamentals/create-new-tenant",
      ],
    ] as const;
    for (const [name, href] of links) {
      const link = screen.getByRole("link", { name });
      expect(link.getAttribute("href")).toBe(href);
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    }
    expect(screen.getByText(/claim code comes from the host terminal/i)).toBeTruthy();
  });

  it("explains public client-only setup without promising a directory to every personal account", () => {
    show("public");
    fireEvent.click(screen.getByText("Personal accounts: get your client ID"));
    const personal = screen.getByRole("region", {
      name: "Personal Microsoft account setup",
    });
    expect(personal.textContent).toMatch(/no tenant ID is needed/);
    expect(personal.textContent).toMatch(
      /Any Entra ID Tenant \+ Personal Microsoft accounts/,
    );
    expect(personal.textContent).toMatch(/subscription and permission requirements/);
    expect(
      screen.queryByRole("region", { name: "Corporate Microsoft account setup" }),
    ).toBeNull();
  });

  it("explains where corporate users copy both identifiers and request permission", () => {
    show("enterprise");
    fireEvent.click(
      screen.getByText("Corporate accounts: get your tenant ID and client ID"),
    );
    const corporate = screen.getByRole("region", {
      name: "Corporate Microsoft account setup",
    });
    expect(corporate.textContent).toMatch(/Directory \(tenant\) ID/);
    expect(corporate.textContent).toMatch(/Application \(client\) ID/);
    expect(corporate.textContent).toMatch(/Single tenant only/);
    expect(corporate.textContent).toMatch(/Service Tree ID/);
    expect(
      within(corporate).getByRole("link", { name: "Find your corporate tenant ID" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("region", { name: "Personal Microsoft account setup" }),
    ).toBeNull();
  });

  it("keeps the native redirect and credential requirements in both paths", () => {
    show();
    fireEvent.click(screen.getByText("First-time setup: personal or corporate account"));
    const checklist = screen.getByRole("region", {
      name: "Microsoft app registration checklist",
    });
    expect(checklist.textContent).toContain(
      "http://localhost:8787/api/auth/entra/callback",
    );
    expect(checklist.textContent).toMatch(/Host's API port.*not the Vite UI port 5173/);
    expect(checklist.textContent).toMatch(/Mobile and desktop applications/);
    expect(checklist.textContent).toMatch(/Do not select Web or SPA/);
    expect(checklist.textContent).toMatch(
      /No client secret or Microsoft Graph permission/,
    );
    expect(checklist.textContent).toMatch(/never a borrowed Visual Studio/);
  });
});
