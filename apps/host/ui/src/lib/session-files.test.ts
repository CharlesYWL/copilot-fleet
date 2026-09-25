import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../hooks/useFleet";
import {
  downloadSessionFile,
  fileName,
  formatFileSize,
  inlineFilePath,
  linkedFilePath,
  sessionFileUrl,
  toolFilePath,
} from "./session-files";

vi.mock("../hooks/useFleet", () => ({ api: vi.fn() }));

describe("files named in a transcript", () => {
  it.each([
    ["file:///C:/Users/me/My%20Report.docx", "C:/Users/me/My Report.docx"],
    ["file:///home/me/report.pdf", "/home/me/report.pdf"],
    ["file://localhost/tmp/a.txt", "/tmp/a.txt"],
    ["file://server/share/a.txt", "\\\\server\\share\\a.txt"],
    // How markdown hands over `[x](C:\Users\me\a b.docx)`.
    ["C:%5CUsers%5Cme%5Ca%20b.docx", "C:\\Users\\me\\a b.docx"],
    ["C:/Users/me/a.docx", "C:/Users/me/a.docx"],
    ["/home/me/out/report.pdf", "/home/me/out/report.pdf"],
    ["docs/report.md#usage", "docs/report.md"],
    ["./report.docx?raw=1", "./report.docx"],
    ["~/report.txt", "~/report.txt"],
  ])("reads the link %s as %s", (href, path) => {
    expect(linkedFilePath(href)).toBe(path);
  });

  it.each([
    undefined,
    "",
    "#section",
    "?page=2",
    "//cdn.example.com/a.js",
    "https://example.com/report.pdf",
    "mailto:someone@example.com",
    "javascript:alert(1)",
    "vscode://file/C:/a.ts",
    "C:relative.txt",
  ])("leaves the link %s alone", (href) => {
    expect(linkedFilePath(href)).toBeUndefined();
  });

  it.each([
    [
      "C:\\Users\\me\\Documents\\Quarterly Report.docx",
      "C:\\Users\\me\\Documents\\Quarterly Report.docx",
    ],
    ["C:/work/out/report.pdf", "C:/work/out/report.pdf"],
    ["\\\\server\\share\\deck.pptx", "\\\\server\\share\\deck.pptx"],
    [
      "/home/me/.copilot/session-state/abc/files/plan.md",
      "/home/me/.copilot/session-state/abc/files/plan.md",
    ],
    ["~/Downloads/data.csv", "~/Downloads/data.csv"],
    ['"C:\\work\\report.docx"', "C:\\work\\report.docx"],
    ["/repo/src/app.ts:42:7", "/repo/src/app.ts"],
    ["file:///C:/work/a%20b.xlsx", "C:/work/a b.xlsx"],
  ])("recognises the inline code %s", (text, path) => {
    expect(inlineFilePath(text)).toBe(path);
  });

  it.each([
    "index.ts",
    "npm test",
    "docs/report.md",
    "/etc/hosts",
    "C:\\work\\folder\\",
    "C:\\src\\*.ts",
    "/bin/sh -c run.sh",
    "C:\\work\\a.txt\nC:\\work\\b.txt",
    "C:\\work\\out\\summary.pdf\n",
    "https://example.com/a.pdf",
    `C:\\${"a".repeat(1100)}.txt`,
  ])("does not turn the inline code %s into a download", (text) => {
    expect(inlineFilePath(text)).toBeUndefined();
  });

  it("takes an edited file from its tool row unless the detail was cut short", () => {
    expect(toolFilePath("C:\\work\\My Docs\\report.md")).toBe(
      "C:\\work\\My Docs\\report.md",
    );
    expect(toolFilePath("src/app.ts")).toBe("src/app.ts");
    expect(toolFilePath("/tmp/a.txt")).toBe("/tmp/a.txt");
    expect(toolFilePath("C:\\work\\a-very-long-path…")).toBeUndefined();
    expect(toolFilePath("rename the helper")).toBeUndefined();
    expect(toolFilePath("src/*.ts")).toBeUndefined();
    expect(toolFilePath(undefined)).toBeUndefined();
  });

  it("names and sizes files for labels", () => {
    expect(fileName("C:\\work\\report.docx")).toBe("report.docx");
    expect(fileName("/tmp/out/")).toBe("out");
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(25 * 1024 * 1024)).toBe("25 MB");
  });
});

describe("downloading a session file", () => {
  let clicked: { href: string; download: string; attached: boolean }[] = [];
  beforeEach(() => {
    clicked = [];
    vi.mocked(api).mockReset();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push({
        href: this.getAttribute("href") ?? "",
        download: this.download,
        attached: document.body.contains(this),
      });
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("checks the file, then hands the resolved path to the browser's download", async () => {
    vi.mocked(api).mockResolvedValueOnce({
      path: "C:\\work\\docs\\report.docx",
      name: "report.docx",
      size: 10,
      modifiedAt: "2026-09-01T00:00:00.000Z",
    });
    const info = await downloadSessionFile("session/1", "docs/report.docx");
    expect(api).toHaveBeenCalledWith(
      "/api/sessions/session%2F1/files/stat?path=docs%2Freport.docx",
    );
    expect(info.name).toBe("report.docx");
    expect(clicked).toEqual([
      {
        href: sessionFileUrl("session/1", "download", "C:\\work\\docs\\report.docx"),
        download: "report.docx",
        attached: true,
      },
    ]);
    expect(document.querySelector("a[download]")).toBeNull();
  });

  it("starts nothing when the Host refuses the file", async () => {
    vi.mocked(api).mockRejectedValueOnce(
      new Error("That file does not exist on this machine."),
    );
    await expect(downloadSessionFile("session", "missing.txt")).rejects.toThrow(
      "does not exist",
    );
    expect(clicked).toEqual([]);
  });
});
