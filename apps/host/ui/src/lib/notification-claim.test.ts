import { beforeEach, describe, expect, it } from "vitest";
import {
  claimLiveNotification,
  resetNotificationClaimsForTest,
} from "./notification-claim";

beforeEach(() => {
  localStorage.clear();
  resetNotificationClaimsForTest();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: undefined,
  });
});

describe("claimLiveNotification", () => {
  it("removes expired and malformed claim keys before writing a new claim", async () => {
    const now = Date.now();
    localStorage.setItem(
      "fleet.notification.claim.expired",
      JSON.stringify({ owner: "old", at: now - 31_000 }),
    );
    localStorage.setItem("fleet.notification.claim.malformed", "{bad");
    localStorage.setItem(
      "fleet.notification.claim.fresh",
      JSON.stringify({ owner: "other", at: now }),
    );
    localStorage.setItem("unrelated", "keep");

    expect(await claimLiveNotification("new", "suppress")).toBe(true);

    expect(localStorage.getItem("fleet.notification.claim.expired")).toBeNull();
    expect(localStorage.getItem("fleet.notification.claim.malformed")).toBeNull();
    expect(localStorage.getItem("fleet.notification.claim.fresh")).not.toBeNull();
    expect(localStorage.getItem("fleet.notification.claim.new")).not.toBeNull();
    expect(localStorage.getItem("unrelated")).toBe("keep");
  });
});
