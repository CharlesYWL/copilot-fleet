import { describe, expect, it, vi } from "vitest";
import { rewriteDevProxyOrigin } from "./dev-proxy.js";

describe("Vite development proxy", () => {
  it("preserves the browser-facing Origin across the internal proxy hop", () => {
    const setHeader = vi.fn();
    rewriteDevProxyOrigin(
      {
        getHeader: (name: string) =>
          name === "origin" ? "http://127.0.0.1:5173" : undefined,
        setHeader,
      },
      "http://127.0.0.1:5173",
    );

    expect(setHeader).toHaveBeenCalledWith("origin", "http://127.0.0.1:5173");
  });

  it("does not invent an Origin for non-browser clients", () => {
    const setHeader = vi.fn();
    rewriteDevProxyOrigin(
      {
        getHeader: () => undefined,
        setHeader,
      },
      "http://127.0.0.1:5173",
    );

    expect(setHeader).not.toHaveBeenCalled();
  });
});
