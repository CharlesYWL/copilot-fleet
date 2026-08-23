import { describe, expect, it } from "vitest";
import { conversationTitle, isUnnamed } from "./conversation-title.js";

describe("naming an orchestrator conversation", () => {
  it("takes the opening sentence, which is usually the request", () => {
    expect(conversationTitle("Add rate limiting to the API. Use Redis if you can.")).toBe(
      "Add rate limiting to the API",
    );
  });

  it("keeps a short single sentence whole", () => {
    expect(conversationTitle("Audit the auth module")).toBe("Audit the auth module");
  });

  it("cuts a long opening at a word rather than mid-word", () => {
    const source =
      "I would like you to investigate why the deployment pipeline keeps timing out";
    const title = conversationTitle(source);

    expect(title.endsWith("…")).toBe(true);
    // The real property: what is kept is a run of whole words from the start,
    // so the title reads as language rather than as a string operation.
    const kept = title.slice(0, -1);
    expect(source.startsWith(kept)).toBe(true);
    expect(source[kept.length]).toBe(" ");
    expect(title.length).toBeLessThanOrEqual(50);
  });

  it("cuts a language without spaces rather than returning nothing", () => {
    /*
     * `lastIndexOf(" ")` is -1 in a Chinese sentence, and trimming to it would
     * give either the whole string or an empty one. The hard cut is correct
     * here, not lazy.
     */
    const title = conversationTitle(
      "帮我研究一下这个仓库的鉴权模块有没有安全问题并且给出一份详细的报告说明每一处风险以及建议的修复顺序",
    );

    expect(title.endsWith("…")).toBe(true);
    expect(title.startsWith("帮我研究一下这个仓库的鉴权模块")).toBe(true);
  });

  it("flattens the newlines a pasted request arrives with", () => {
    expect(conversationTitle("  Fix the   build\n\nit is red  ")).toBe(
      "Fix the build it is red",
    );
  });

  it("has nothing to say about an empty message", () => {
    expect(conversationTitle("   ")).toBe("");
  });

  it("treats the names nobody chose as free to replace", () => {
    // The Host opens every conversation as "Orchestrator", so that is not a
    // name somebody picked — but anything else is, and theirs wins.
    expect(isUnnamed("Orchestrator")).toBe(true);
    expect(isUnnamed("  ")).toBe(true);
    expect(isUnnamed("New conversation")).toBe(true);
    expect(isUnnamed("Rate limiting work")).toBe(false);
  });
});
