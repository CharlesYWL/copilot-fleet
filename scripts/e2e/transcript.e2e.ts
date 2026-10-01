import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  FakeNode,
  PAGE_SCRIPT,
  conversationName,
  endMarker,
  freePort,
  prepareConversations,
  startHost,
  stopHost,
  type PageHarness,
  type PreparedConversations,
} from "./harness.js";

/**
 * Long transcripts in a real browser.
 *
 * jsdom cannot lay out a virtual list, so the unit tests replace it with one
 * that renders every row. These drive the built app instead: scrolling,
 * anchoring, focus and reconnects only mean something with real geometry and a
 * real Host.
 */

const root = fileURLToPath(new URL("../../", import.meta.url));
const REGION = '[aria-label="Chat transcript"]';
const FIRST_PROMPT = "Inspect synthetic example 0.";

let directory: string;
let prepared: PreparedConversations;
let host: Awaited<ReturnType<typeof startHost>> | undefined;
let node: FakeNode | undefined;
let browser: Browser | undefined;
let context: BrowserContext | undefined;
let page: Page;
let lead: string;

type Scroll = { top: number; height: number; client: number };

const scroll = () =>
  page.evaluate((selector) => {
    const region = document.querySelector(selector)!;
    return {
      top: region.scrollTop,
      height: region.scrollHeight,
      client: region.clientHeight,
    };
  }, REGION);
const atBottom = (value: Scroll) => value.height - value.top - value.client < 4;
const scrollTo = (top: number) =>
  page.evaluate(
    ([selector, value]) => {
      document.querySelector(selector as string)!.scrollTop = value as number;
    },
    [REGION, top] as const,
  );

/** Whether `needle` is drawn inside the visible part of the transcript. */
const onScreen = (needle: string) =>
  page.evaluate(
    ([selector, text]) => {
      const region = document.querySelector(selector!);
      if (!region) return false;
      const bounds = region.getBoundingClientRect();
      const walker = document.createTreeWalker(region, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.includes(text!)) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const rect = range.getBoundingClientRect();
        if (rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom)
          return true;
      }
      return false;
    },
    [REGION, needle],
  );

/** How many rendered text nodes in the transcript contain `needle`. */
const occurrences = (needle: string) =>
  page.evaluate(
    ([selector, text]) => {
      const region = document.querySelector(selector!);
      if (!region) return 0;
      let count = 0;
      const walker = document.createTreeWalker(region, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode())
        if (node.textContent?.includes(text!)) count++;
      return count;
    },
    [REGION, needle],
  );

/** Absolute positions of the mounted rows, top to bottom. */
const mounted = () =>
  page.evaluate(
    (selector) =>
      [...document.querySelectorAll(`${selector} [data-item-index]`)].map((item) =>
        Number(item.getAttribute("data-item-index")),
      ),
    REGION,
  );

/** A mounted row's top edge relative to the transcript, or null if unmounted. */
const rowTop = (index: number) =>
  page.evaluate(
    ([selector, position]) => {
      const region = document.querySelector(selector as string)!;
      const row = region.querySelector(`[data-item-index="${position as number}"]`);
      return row
        ? row.getBoundingClientRect().top - region.getBoundingClientRect().top
        : null;
    },
    [REGION, index] as const,
  );

/** Polls with room for a loaded machine; every wait here is for a paint. */
const eventually = <T>(read: () => Promise<T>) => expect.poll(read, { timeout: 5_000 });

/** Lets the list finish following, measuring and correcting before acting on it. */
async function settle(): Promise<void> {
  await page.evaluate(
    () =>
      new Promise((accept) => requestAnimationFrame(() => requestAnimationFrame(accept))),
  );
  await page.waitForTimeout(250);
}

/** Scrolls the transcript with the mouse wheel, as a reader does. */
async function wheel(deltaY: number): Promise<void> {
  const box = (await page
    .getByRole("region", { name: "Chat transcript" })
    .boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, deltaY);
}

const pick = (index: number) =>
  page
    .locator(`button[title="${conversationName(index)}"]`)
    .first()
    .click();

async function open(index: number): Promise<void> {
  await pick(index);
  await page.getByText(endMarker(index), { exact: true }).first().waitFor();
}

const harness = (action: "disconnect" | "reconnect") =>
  page.evaluate(
    (name) => (window as unknown as { __harness: PageHarness }).__harness[name](),
    action,
  );

/** True when `url` is a request for an older page of `sessionId`'s transcript. */
const olderPage = (sessionId: string) => (url: URL) =>
  url.pathname === `/api/sessions/${sessionId}/transcript` &&
  url.searchParams.has("before");

describe("long transcripts in a real browser", () => {
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "fleet-e2e-"));
    const database = join(directory, "fleet.db");
    // Three pages of 200 blocks in the long conversation, and two short ones.
    prepared = prepareConversations(database, { events: 12_000, sessions: 3 });
    lead = prepared.ids[0]!;
    host = await startHost(root, database, await freePort());
    node = await FakeNode.connect(host.url, prepared);
    browser = await chromium.launch({
      channel: process.env.FLEET_E2E_BROWSER ?? "msedge",
      headless: true,
    });
  });

  afterAll(async () => {
    node?.close();
    await browser?.close();
    if (host) await stopHost(host.child);
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  beforeEach(async () => {
    context = await browser!.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();
    await page.addInitScript(PAGE_SCRIPT);
    await page.goto(host!.url);
    // The page opens on the first listed conversation, a short one.
    await page.getByText(endMarker(1), { exact: true }).first().waitFor();
  });

  afterEach(async () => {
    await context?.close();
  });

  it("opens a long conversation at its newest line with only a screenful mounted", async () => {
    await open(0);

    await eventually(() => onScreen(endMarker(0))).toBe(true);
    expect(atBottom(await scroll())).toBe(true);
    const rows = await mounted();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(60);
    // Only the newest page is loaded, not the first prompt.
    expect(Math.min(...rows)).toBeGreaterThan(prepared.leadBlocks / 2);
    expect(await occurrences(FIRST_PROMPT)).toBe(0);
  });

  it("loads older pages while scrolling up without moving what is being read", async () => {
    await open(0);
    let release: () => void = () => {};
    let requested: () => void = () => {};
    // Holds each older page until the row at the top has been measured.
    await page.route(olderPage(lead), async (route) => {
      const gate = new Promise<void>((accept) => (release = accept));
      requested();
      await gate;
      await route.continue();
    });

    let pages = 0;
    for (let step = 0; step < 10; step++) {
      const asked = new Promise<boolean>((accept) => (requested = () => accept(true)));
      await scrollTo(0);
      // Reaching the top asks for the page above; at the first block, nothing does.
      if (!(await Promise.race([asked, delay(2_000).then(() => false)]))) break;
      await settle();
      const top = Math.min(...(await mounted()));
      const before = (await rowTop(top))!;
      release();
      await eventually(async () => Math.min(...(await mounted()))).toBeLessThan(top);
      // Virtuoso corrects its offset for the new rows within a frame or two.
      await eventually(async () => {
        const after = await rowTop(top);
        return after === null ? Infinity : Math.abs(after - before);
      }).toBeLessThan(4);
      pages++;
    }

    expect(pages).toBeGreaterThanOrEqual(2);
    await scrollTo(0);
    await eventually(() => onScreen(FIRST_PROMPT)).toBe(true);
    // All three pages are loaded, and still only a screenful is mounted.
    expect((await mounted()).length).toBeLessThan(60);
  });

  it("follows new output only while pinned, and offers a jump back", async () => {
    await open(0);
    node!.say(lead, "FOLLOW-ONE");
    await eventually(() => onScreen("FOLLOW-ONE")).toBe(true);
    await settle();
    expect(atBottom(await scroll())).toBe(true);

    await wheel(-2_000);
    const jump = page.getByRole("button", { name: "Jump to latest" });
    await jump.waitFor();
    await settle();
    const reading = (await scroll()).top;
    node!.say(lead, "FOLLOW-TWO");

    await eventually(() => jump.textContent()).toContain("new");
    expect(Math.abs((await scroll()).top - reading)).toBeLessThan(2);
    expect(await onScreen("FOLLOW-TWO")).toBe(false);

    await jump.click();
    await eventually(() => onScreen("FOLLOW-TWO")).toBe(true);
    await eventually(async () => atBottom(await scroll())).toBe(true);
  });

  it("jumps to prompts whose pages have not been loaded yet", async () => {
    await open(0);
    const marks = page.getByRole("button", { name: /^Jump to prompt: / });
    await marks.first().waitFor();
    const labels = (await marks.evaluateAll((items) =>
      items.map((item) => item.getAttribute("aria-label")!),
    )) as string[];
    const prompt = (label: string) => label.replace(/^Jump to prompt: /, "");
    const middle = labels[Math.floor(labels.length / 2)]!;

    for (const label of [middle, labels[0]!, labels.at(-1)!]) {
      await page.getByRole("button", { name: label, exact: true }).click();
      await eventually(() => onScreen(prompt(label))).toBe(true);
    }
    expect(prompt(labels[0]!)).toBe(FIRST_PROMPT);
  });

  it("keeps an expanded thought open after it scrolls away and back", async () => {
    await open(0);
    node!.send(lead, [
      { type: "turn_complete", payload: { stopReason: "end_turn" } },
      { type: "agent_thought", payload: { text: "EXPANDED-THOUGHT stays open" } },
    ]);
    const row = page
      .locator(`${REGION} [data-item-index]`, { hasText: "EXPANDED-THOUGHT" })
      .locator("button[aria-expanded]");
    await row.waitFor();
    await row.click();
    await eventually(() => row.getAttribute("aria-expanded")).toBe("true");
    await settle();

    await scrollTo(0);
    await eventually(() => row.count()).toBe(0);
    await page.getByRole("button", { name: "Jump to latest" }).click();

    await row.waitFor();
    expect(await row.getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps typing in the composer while output streams, and scrolls by keyboard", async () => {
    await open(0);
    const composer = page.getByRole("textbox", { name: "Follow-up prompt" });
    await composer.click();
    await composer.pressSequentially("draft ", { delay: 20 });
    for (let index = 0; index < 20; index++)
      node!.send(lead, [{ type: "agent_text", payload: { text: ` stream-${index}` } }]);
    await composer.pressSequentially("kept", { delay: 20 });

    await eventually(() => onScreen("stream-19")).toBe(true);
    expect(await composer.inputValue()).toBe("draft kept");
    expect(await composer.evaluate((element) => element === document.activeElement)).toBe(
      true,
    );

    const region = page.getByRole("region", { name: "Chat transcript" });
    await region.focus();
    const bottom = (await scroll()).top;
    await page.keyboard.press("PageUp");
    await eventually(async () => (await scroll()).top).toBeLessThan(bottom);
    await page.keyboard.press("End");
    await eventually(async () => atBottom(await scroll())).toBe(true);
  });

  it("catches up on output stored while disconnected, without duplicates", async () => {
    await open(0);
    await harness("disconnect");
    await page
      .getByText(/Connection to the Host lost/)
      .first()
      .waitFor();
    node!.say(lead, "WHILE-OFFLINE-ONE");
    node!.say(lead, "WHILE-OFFLINE-TWO");
    await page.waitForTimeout(500);
    expect(await occurrences("WHILE-OFFLINE-ONE")).toBe(0);

    await harness("reconnect");
    await expect
      .poll(() => onScreen("WHILE-OFFLINE-TWO"), { timeout: 20_000 })
      .toBe(true);
    expect(await occurrences("WHILE-OFFLINE-ONE")).toBe(1);
    expect(await occurrences("WHILE-OFFLINE-TWO")).toBe(1);

    node!.say(lead, "AFTER-RECONNECT");
    await eventually(() => onScreen("AFTER-RECONNECT")).toBe(true);
    expect(await occurrences("AFTER-RECONNECT")).toBe(1);
    expect(await occurrences("WHILE-OFFLINE-TWO")).toBe(1);
  });

  it("shows only the last chosen conversation after rapid switching", async () => {
    // The long conversation's pages arrive late, after it has been left.
    await page.route(
      (url) => url.pathname === `/api/sessions/${lead}/transcript`,
      async (route) => {
        await new Promise((accept) => setTimeout(accept, 400));
        await route.continue().catch(() => {});
      },
    );
    for (const index of [0, 2, 0, 1, 0, 2]) await pick(index);

    await eventually(() => onScreen(endMarker(2))).toBe(true);
    await page.waitForTimeout(1_000);
    expect(await onScreen(endMarker(2))).toBe(true);
    expect(await occurrences(endMarker(0))).toBe(0);
    expect(await occurrences(endMarker(1))).toBe(0);
  });
});
