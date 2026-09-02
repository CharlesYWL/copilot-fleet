import { useCallback, useEffect, useRef, useState } from "react";
import type { Notification as FleetNotification } from "@fleet/protocol";
import { playChime } from "../lib/chime";
import {
  claimLiveNotification,
  type LiveNotificationClaim,
} from "../lib/notification-claim";
import type { LiveNotificationUpdate } from "./useFleet";

const SOUND_STORAGE_KEY = "fleet.sound";
const BROWSER_STORAGE_KEY = "fleet.browser-notifications";
const BASE_TITLE = "Copilot Fleet";

function storedFlag(key: string, fallback: boolean): boolean {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value === "on";
  } catch {
    return fallback;
  }
}

function persistFlag(key: string, enabled: boolean): void {
  try {
    localStorage.setItem(key, enabled ? "on" : "off");
  } catch {
    // A storage-blocked browser still keeps the choice for this tab.
  }
}

export type NotificationDeliveryControls = {
  soundEnabled: boolean;
  toggleSound: () => void;
  browserEnabled: boolean;
  toggleBrowser: () => void;
};

export function useNotificationDelivery(input: {
  notificationUpdates: readonly LiveNotificationUpdate[];
  unreadCount: number;
  isTargetVisible: (notification: FleetNotification) => boolean;
  onToast: (notification: FleetNotification) => void;
  onNavigate: (notification: FleetNotification) => void;
}): NotificationDeliveryControls {
  const [soundEnabled, setSoundEnabled] = useState(() =>
    storedFlag(SOUND_STORAGE_KEY, true),
  );
  const [browserEnabled, setBrowserEnabled] = useState(() =>
    storedFlag(BROWSER_STORAGE_KEY, false),
  );
  const delivered = useRef(new Set<string>());
  const pending = useRef(new Set<string>());
  const processedUpdates = useRef(new Set<number>());
  const desktopNotifications = useRef(new Map<string, Notification>());
  const latestNotifications = useRef(new Map<string, FleetNotification>());
  const inputRef = useRef(input);
  const browserEnabledRef = useRef(browserEnabled);
  const soundEnabledRef = useRef(soundEnabled);
  inputRef.current = input;
  browserEnabledRef.current = browserEnabled;
  soundEnabledRef.current = soundEnabled;

  useEffect(() => {
    document.title =
      input.unreadCount > 0 ? `(${input.unreadCount}) ${BASE_TITLE}` : BASE_TITLE;
  }, [input.unreadCount]);

  useEffect(() => {
    for (const update of input.notificationUpdates) {
      if (processedUpdates.current.has(update.sequence)) continue;
      processedUpdates.current.add(update.sequence);
      const notification = update.notification;
      latestNotifications.current.set(notification.id, notification);

      if (notification.status === "resolved" || notification.status === "dismissed") {
        desktopNotifications.current.get(notification.id)?.close();
        desktopNotifications.current.delete(notification.id);
        continue;
      }
      if (
        !update.deliver ||
        delivered.current.has(notification.id) ||
        pending.current.has(notification.id)
      ) {
        continue;
      }

      const eligibility = deliveryEligibility(
        notification,
        browserEnabled,
        soundEnabled,
        input.isTargetVisible,
      );
      if (!eligibility) continue;
      pending.current.add(notification.id);
      void claimLiveNotification(notification.id, eligibility, () => {
        const latest = latestNotifications.current.get(notification.id);
        return (
          latest?.status === "active" &&
          deliveryEligibility(
            latest,
            browserEnabledRef.current,
            soundEnabledRef.current,
            inputRef.current.isTargetVisible,
          ) === eligibility
        );
      }).then((claimed) => {
        pending.current.delete(notification.id);
        if (!claimed) return;
        delivered.current.add(notification.id);

        const current = inputRef.current;
        const latest = latestNotifications.current.get(notification.id);
        if (!latest || latest.status !== "active") return;
        if (eligibility === "suppress") return;
        if (soundEnabledRef.current) {
          playChime(latest.kind === "agent_completion" ? "done" : "permission");
        }
        if (eligibility === "visible") {
          current.onToast(latest);
          return;
        }
        if (eligibility === "sound") return;

        const desktop = new Notification(latest.title, {
          body: latest.body,
          tag: latest.id,
          requireInteraction:
            latest.kind === "permission_request" ||
            latest.kind === "orchestration_needs_review",
        });
        desktopNotifications.current.set(latest.id, desktop);
        desktop.onclick = () => {
          window.focus();
          current.onNavigate(latest);
          desktop.close();
          desktopNotifications.current.delete(latest.id);
        };
      });
    }

    const retainedSequences = new Set(
      input.notificationUpdates.map((update) => update.sequence),
    );
    const retainedIds = new Set(
      input.notificationUpdates.map((update) => update.notification.id),
    );
    for (const sequence of processedUpdates.current) {
      if (!retainedSequences.has(sequence)) processedUpdates.current.delete(sequence);
    }
    for (const id of delivered.current) {
      if (!retainedIds.has(id)) delivered.current.delete(id);
    }
    for (const id of latestNotifications.current.keys()) {
      if (!retainedIds.has(id) && !pending.current.has(id)) {
        latestNotifications.current.delete(id);
      }
    }
  }, [input.notificationUpdates, input.isTargetVisible, browserEnabled, soundEnabled]);

  const toggleSound = useCallback(() => {
    setSoundEnabled((current) => {
      const next = !current;
      persistFlag(SOUND_STORAGE_KEY, next);
      if (next) playChime("done");
      return next;
    });
  }, []);

  const toggleBrowser = useCallback(() => {
    if (browserEnabled) {
      persistFlag(BROWSER_STORAGE_KEY, false);
      setBrowserEnabled(false);
      return;
    }
    if (typeof Notification === "undefined") return;
    const enable = (permission: NotificationPermission) => {
      const granted = permission === "granted";
      persistFlag(BROWSER_STORAGE_KEY, granted);
      setBrowserEnabled(granted);
    };
    if (Notification.permission === "default") {
      void Notification.requestPermission().then(enable, () => enable("denied"));
      return;
    }
    enable(Notification.permission);
  }, [browserEnabled]);

  return {
    soundEnabled,
    toggleSound,
    browserEnabled,
    toggleBrowser,
  };
}

function deliveryEligibility(
  notification: FleetNotification,
  browserEnabled: boolean,
  soundEnabled: boolean,
  isTargetVisible: (notification: FleetNotification) => boolean,
): LiveNotificationClaim | undefined {
  const current = document.visibilityState;
  if (current === "visible") {
    return isTargetVisible(notification) ? "suppress" : "visible";
  }
  if (
    browserEnabled &&
    typeof Notification !== "undefined" &&
    Notification.permission === "granted"
  ) {
    return "browser";
  }
  return soundEnabled ? "sound" : undefined;
}
