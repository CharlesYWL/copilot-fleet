import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumeFirstClaimTour,
  markFirstClaimTour,
  readTourProgress,
  saveTourProgress,
  TOUR_STORAGE_KEY,
  tourSteps,
} from "./onboarding";

beforeEach(() => {
  sessionStorage.clear();
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  window.history.replaceState({}, "", "/");
});

describe("setup tour progress", () => {
  it("does not show a tour just because browser storage is empty", () => {
    expect(readTourProgress()).toBeUndefined();
  });

  it("starts at the welcome after a first claim and preserves unrelated URL state", () => {
    window.history.replaceState({ returnTo: "session" }, "", "/?keep=yes#details");
    saveTourProgress(tourSteps[4]);
    markFirstClaimTour();

    expect(readTourProgress()?.id).toBe("welcome");
    consumeFirstClaimTour();
    expect(window.location.search).toBe("?keep=yes");
    expect(window.location.hash).toBe("#details");
    expect(window.history.state).toEqual({ returnTo: "session" });
  });

  it("remembers a step in this tab and clears it when dismissed", () => {
    saveTourProgress(tourSteps[4]);
    expect(sessionStorage.getItem(TOUR_STORAGE_KEY)).toBe("placement");
    expect(readTourProgress()?.id).toBe("placement");
    saveTourProgress();
    expect(readTourProgress()).toBeUndefined();
  });

  it("does not replay an unrecognized saved step or a truthy welcome value", () => {
    sessionStorage.setItem(TOUR_STORAGE_KEY, "not-a-step");
    window.history.replaceState({}, "", "/?welcome=true");
    expect(readTourProgress()).toBeUndefined();
  });

  it("remains usable when browser storage is blocked and reports the limitation", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Storage blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage blocked", "SecurityError");
    });
    expect(readTourProgress()).toBeUndefined();
    saveTourProgress(tourSteps[0]);
    expect(warning).toHaveBeenCalledTimes(2);
    markFirstClaimTour();
    expect(readTourProgress()?.id).toBe("welcome");
  });
});
