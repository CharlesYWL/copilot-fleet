import { describe, expect, it } from "vitest";
import { highlightSegments, matchesAllTerms, searchTerms } from "./search-text";

describe("searchTerms", () => {
  it("splits on whitespace, lowercases, and drops empty pieces", () => {
    expect(searchTerms("  Checkout   WEILI-pc \t lint ")).toEqual([
      "checkout",
      "weili-pc",
      "lint",
    ]);
  });

  it("treats a blank query as no search at all", () => {
    expect(searchTerms("")).toEqual([]);
    expect(searchTerms("   ")).toEqual([]);
  });

  it("collapses a term repeated in the query", () => {
    expect(searchTerms("node Node NODE")).toEqual(["node"]);
  });
});

describe("matchesAllTerms", () => {
  it("needs every term somewhere in the fields, in any order", () => {
    const fields = ["checkout-service", "WEILI-PC", "Fix the lint warnings"];
    expect(matchesAllTerms(fields, ["lint", "weili"])).toBe(true);
    expect(matchesAllTerms(fields, ["lint", "build"])).toBe(false);
  });

  it("matches a term spread across the fields, not just within one", () => {
    expect(matchesAllTerms(["checkout", "WEILI-PC"], ["checkout", "weili"])).toBe(true);
  });

  it("matches everything when there are no terms", () => {
    expect(matchesAllTerms(["anything"], [])).toBe(true);
  });

  it("ignores case on the field side", () => {
    expect(matchesAllTerms(["YOLO mode"], ["yolo"])).toBe(true);
  });
});

describe("highlightSegments", () => {
  it("returns the text whole when nothing matches", () => {
    expect(highlightSegments("Default apps", ["zzz"])).toEqual([
      { text: "Default apps", match: false },
    ]);
  });

  it("marks every occurrence of a term, case-insensitively", () => {
    expect(highlightSegments("Default save defaults", ["def"])).toEqual([
      { text: "Def", match: true },
      { text: "ault save ", match: false },
      { text: "def", match: true },
      { text: "aults", match: false },
    ]);
  });

  it("merges overlapping and touching matches into one run", () => {
    expect(highlightSegments("checkout", ["check", "kout"])).toEqual([
      { text: "checkout", match: true },
    ]);
    expect(highlightSegments("abcdef", ["abc", "def"])).toEqual([
      { text: "abcdef", match: true },
    ]);
  });

  it("keeps the original casing of the text it splits", () => {
    expect(highlightSegments("WEILI-PC", ["weili"])).toEqual([
      { text: "WEILI", match: true },
      { text: "-PC", match: false },
    ]);
  });

  it("returns the text whole when there are no terms", () => {
    expect(highlightSegments("anything", [])).toEqual([
      { text: "anything", match: false },
    ]);
  });
});
