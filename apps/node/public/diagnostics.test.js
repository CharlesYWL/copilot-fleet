import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initDiagnostics } from "./diagnostics.js";

const here = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(here, "index.html"), "utf8");
const markup = page.slice(page.indexOf("<body>") + 6, page.indexOf("</body>"));
const $ = (id) => document.getElementById(id);
const entry = (level, message) => ({ at: "2026-09-14T12:00:00.000Z", level, message });

let entries;
let hidden;

const start = async () => {
  initDiagnostics({ loadConfig: vi.fn(), renderConfig: vi.fn() });
  await vi.waitFor(() => expect($("logs").textContent).not.toBe("Loading…"));
};

const changeFilter = async () => {
  $("logProblemsOnly").click();
  await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
  document.body.innerHTML = markup;
  entries = [];
  vi.useFakeTimers();
  hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ entries }) })),
  );
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("node runtime diagnostics", () => {
  it("shows normal logs and problems by default and escapes log content", async () => {
    entries = [
      entry("info", "Connected <script>alert('log')</script>"),
      entry("warn", "Retrying connection"),
      entry("error", "Connection failed"),
    ];
    await start();
    expect($("logProblemsOnly").checked).toBe(false);
    expect($("logs").children).toHaveLength(3);
    expect($("logs").textContent).toContain("Connected <script>alert('log')</script>");
    expect($("logs").querySelector("script")).toBeNull();
    expect($("logs").querySelector(".lvl-warn").textContent).toContain(
      "Retrying connection",
    );
    expect($("logs").querySelector(".lvl-error").textContent).toContain(
      "Connection failed",
    );
    expect($("logs").getAttribute("role")).toBe("log");

    await changeFilter();
    expect($("logs").children).toHaveLength(2);
    expect($("logs").querySelector(".lvl-info")).toBeNull();
  });

  it("shows the latest 80 matching entries, filtering before taking the tail", async () => {
    entries = ["warn", "info"].flatMap((level) =>
      Array.from({ length: 100 }, (_, index) => entry(level, `${level} ${index}`)),
    );
    await start();
    expect($("logs").children).toHaveLength(80);
    expect($("logs").firstChild.textContent).toContain("info 20");
    expect($("logs").lastChild.textContent).toContain("info 99");

    await changeFilter();
    expect($("logs").children).toHaveLength(80);
    expect($("logs").firstChild.textContent).toContain("warn 20");
    expect($("logs").lastChild.textContent).toContain("warn 99");
    expect($("logs").querySelector(".lvl-info")).toBeNull();

    await changeFilter();
    expect($("logs").firstChild.textContent).toContain("info 20");
  });

  it("distinguishes an empty log from a problems filter with no matches", async () => {
    await start();
    expect($("logs").textContent).toBe("Nothing logged yet.");
    entries = [entry("info", "Node ready")];
    await changeFilter();
    expect($("logs").textContent).toBe("No warnings or errors recorded.");
    await changeFilter();
    expect($("logs").textContent).toContain("Node ready");
  });

  it.each(["http", "network"])(
    "renders %s errors and recovers on refresh",
    async (kind) => {
      if (kind === "http") {
        vi.mocked(fetch).mockResolvedValueOnce({
          ok: false,
          json: async () => ({ error: "Logs unavailable" }),
        });
      } else {
        vi.mocked(fetch).mockRejectedValueOnce(new Error("Logs unavailable"));
      }
      await start();
      expect($("logs").querySelector(".lvl-error").textContent).toBe("Logs unavailable");
      entries = [entry("info", "Node ready")];
      $("logRefresh").click();
      await vi.advanceTimersByTimeAsync(0);
      expect($("logs").textContent).toContain("Node ready");
      expect($("logs").textContent).not.toContain("Logs unavailable");
    },
  );

  it("keeps polling every five seconds, except while the browser tab is hidden", async () => {
    entries = [entry("info", "Node starting")];
    await start();
    entries = [entry("info", "Node ready")];
    await vi.advanceTimersByTimeAsync(5_000);
    expect($("logs").textContent).toContain("Node ready");
    expect(fetch).toHaveBeenCalledTimes(2);

    hidden.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    hidden.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("follows the tail only while the reader stays pinned to the bottom", async () => {
    entries = [entry("info", "Node ready")];
    await start();
    const log = $("logs");
    Object.defineProperties(log, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 100 },
    });
    log.scrollTop = 900;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(log.scrollTop).toBe(1000);

    log.scrollTop = 250;
    Object.defineProperty(log, "scrollHeight", { value: 1200 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(log.scrollTop).toBe(250);
  });
});
