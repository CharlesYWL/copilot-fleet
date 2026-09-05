import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { FluentProvider } from "@fluentui/react-components";
import { PortableBackupCard } from "./PortableBackupCard";
import { forgetCsrfToken } from "../lib/auth";
import { fleetDarkTheme } from "../theme";

const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const show = (props: Partial<React.ComponentProps<typeof PortableBackupCard>> = {}) =>
  render(
    <FluentProvider theme={fleetDarkTheme}>
      <PortableBackupCard claimed={true} onImported={() => {}} {...props} />
    </FluentProvider>,
  );

const passphraseField = () => screen.getByLabelText(/backup passphrase/i);

/**
 * The archive that moves a Host.
 *
 * It is the administrator table, the Entra registration, and every key the Host
 * signs and derives with, in one file. So the UI around it is a security
 * surface: it has to ask for a passphrase it never keeps, tell the operator
 * what the file actually is, and hand a refusal back as something they can act
 * on rather than a silent no-op.
 */
describe("PortableBackupCard", () => {
  beforeEach(() => {
    forgetCsrfToken();
  });

  afterEach(() => {
    forgetCsrfToken();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("will not export until the passphrase is long enough to be worth deriving", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      void input;
      return answer({ csrfToken: "proof" });
    });
    vi.stubGlobal("fetch", fetchMock);
    show();

    fireEvent.change(passphraseField(), { target: { value: "too-short" } });
    fireEvent.click(screen.getByRole("button", { name: /export portable backup/i }));

    expect(await screen.findByText(/at least 14 characters/i)).toBeTruthy();
    expect(
      fetchMock.mock.calls.some((call) =>
        String(call[0]).includes("/api/backup/portable"),
      ),
    ).toBe(false);
  });

  it("seals the archive with the passphrase and hands it back as a download", async () => {
    const created: { name: string }[] = [];
    const objectUrl = vi.fn(() => "blob:fleet");
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: objectUrl,
      revokeObjectURL: vi.fn(),
    });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        created.push({ name: this.download });
      });

    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/auth/csrf")) return answer({ csrfToken: "proof" });
      if (url.includes("/api/backup/portable")) {
        expect((init?.headers as Record<string, string>)["x-csrf-token"]).toBe("proof");
        expect(JSON.parse(String(init?.body)) as { passphrase: string }).toEqual({
          passphrase: "correct horse battery staple",
        });
        return answer({ kind: "copilot-fleet-host", version: 2 });
      }
      return answer({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    show();

    fireEvent.change(passphraseField(), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.click(screen.getByRole("button", { name: /export portable backup/i }));

    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]!.name).toMatch(/portable/);
    expect(objectUrl).toHaveBeenCalled();
    click.mockRestore();
  });

  /*
   * Handing over the Host's authority is the single most consequential thing an
   * administrator can do from a browser, so the Host asks them to prove it is
   * still them. That refusal has to read as an instruction, not a failure.
   */
  it("explains a refusal that only wants a fresh Microsoft sign-in", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.includes("/api/auth/csrf")) return answer({ csrfToken: "proof" });
      return answer(
        { error: "Sign in with Microsoft again to confirm this change." },
        403,
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    show();

    fireEvent.change(passphraseField(), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.click(screen.getByRole("button", { name: /export portable backup/i }));

    expect(await screen.findByText(/sign in with microsoft again/i)).toBeTruthy();
  });

  it("never leaves the passphrase in the form once it has been used", async () => {
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:fleet"),
      revokeObjectURL: vi.fn(),
    });
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.includes("/api/auth/csrf")) return answer({ csrfToken: "proof" });
      return answer({ kind: "copilot-fleet-host", version: 2 });
    });
    vi.stubGlobal("fetch", fetchMock);
    show();

    fireEvent.change(passphraseField(), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.click(screen.getByRole("button", { name: /export portable backup/i }));

    await waitFor(() => expect((passphraseField() as HTMLInputElement).value).toBe(""));
  });

  it("imports an archive an administrator picked, with its passphrase", async () => {
    const imported: unknown[] = [];
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/auth/csrf")) return answer({ csrfToken: "proof" });
      if (url.includes("/api/backup/portable/import")) {
        imported.push(JSON.parse(String(init?.body)));
        return answer({ ok: true, administrators: 2 });
      }
      return answer({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    const onImported = vi.fn();
    show({ onImported });

    fireEvent.change(passphraseField(), {
      target: { value: "correct horse battery staple" },
    });
    const file = new File(
      [JSON.stringify({ kind: "copilot-fleet-host", version: 2 })],
      "fleet.json",
      { type: "application/json" },
    );
    const picker = screen.getByLabelText(/choose a portable archive/i);
    fireEvent.change(picker, { target: { files: [file] } });

    const confirm = await screen.findByRole("button", { name: /replace this host/i });
    fireEvent.click(confirm);

    await waitFor(() => expect(imported).toHaveLength(1));
    expect(imported[0]).toMatchObject({
      passphrase: "correct horse battery staple",
      backup: { kind: "copilot-fleet-host", version: 2 },
    });
    await waitFor(() => expect(onImported).toHaveBeenCalled());
  });

  it("says so plainly when the picked file is not an archive", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer({ csrfToken: "proof" })),
    );
    show();

    fireEvent.change(passphraseField(), {
      target: { value: "correct horse battery staple" },
    });
    const file = new File(["not json at all"], "notes.txt", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText(/choose a portable archive/i), {
      target: { files: [file] },
    });

    expect(await screen.findByText(/not a copilot fleet portable archive/i)).toBeTruthy();
  });

  /*
   * A Host nobody owns has no administrator to ask, so it asks for the code on
   * its console instead — the same proof a first claim takes. The card has to
   * say so, because otherwise the only visible path is a sign-in that cannot
   * happen yet.
   */
  it("offers bootstrap import on a Host that has not been claimed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer({ csrfToken: "proof" })),
    );
    show({ claimed: false });

    const card = screen.getByRole("region", { name: /move this host/i });
    expect(within(card).getByText(/claim code printed on/i)).toBeTruthy();
    expect(
      within(card).queryByRole("button", { name: /export portable backup/i }),
    ).toBeNull();
  });

  /**
   * A CSRF token is derived from an operator session, and the Host that most
   * needs restoring is the one with no sessions at all.
   *
   * On an unclaimed Host `/api/auth/csrf` answers 401, so asking for one before
   * the import turns the whole recovery path into an error message about a
   * token nobody could have. The Host authorises this call with the console
   * claim grant instead — a cookie bound to this browser — so there is nothing
   * for a CSRF proof to add, and nothing for it to break.
   */
  it("imports on an unclaimed Host without asking for an operator CSRF token", async () => {
    const imported: RequestInit[] = [];
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/auth/csrf")) {
        return answer({ error: "Sign in to use this Host" }, 401);
      }
      if (url.includes("/api/backup/portable/import")) {
        imported.push(init ?? {});
        return answer({ ok: true, administrators: 1 });
      }
      return answer({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    show({ claimed: false });

    fireEvent.change(passphraseField(), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.change(screen.getByLabelText(/choose a portable archive/i), {
      target: {
        files: [
          new File(
            [JSON.stringify({ kind: "copilot-fleet-host", version: 2 })],
            "fleet.json",
            { type: "application/json" },
          ),
        ],
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: /replace this host/i }));

    await waitFor(() => expect(imported).toHaveLength(1));
    const headers = (imported[0]!.headers ?? {}) as Record<string, string>;
    expect(headers["x-csrf-token"]).toBeUndefined();
    expect(
      fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/auth/csrf")),
    ).toBe(false);
  });

  /*
   * The other half of the same rule. A claimed Host authorises the restore with
   * an operator session, and a session-authorised state change without a CSRF
   * proof is a cross-site request away from being someone else's.
   */
  it("still proves the request on a Host that has administrators", async () => {
    const imported: RequestInit[] = [];
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/auth/csrf")) return answer({ csrfToken: "proof" });
      if (url.includes("/api/backup/portable/import")) {
        imported.push(init ?? {});
        return answer({ ok: true, administrators: 2 });
      }
      return answer({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    show({ claimed: true });

    fireEvent.change(passphraseField(), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.change(screen.getByLabelText(/choose a portable archive/i), {
      target: {
        files: [
          new File(
            [JSON.stringify({ kind: "copilot-fleet-host", version: 2 })],
            "fleet.json",
            { type: "application/json" },
          ),
        ],
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: /replace this host/i }));

    await waitFor(() => expect(imported).toHaveLength(1));
    expect((imported[0]!.headers as Record<string, string>)["x-csrf-token"]).toBe(
      "proof",
    );
  });
});
