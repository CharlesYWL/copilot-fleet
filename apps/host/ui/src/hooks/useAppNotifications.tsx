import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { Notification } from "@fleet/protocol";

export type NotificationIntent = "error" | "success" | "warning" | "info";

type ApplicationMessage = Omit<
  Notification,
  "kind" | "category" | "navigation" | "subject"
> & {
  kind: "app_message";
  category: "application";
  intent: NotificationIntent;
  navigation: { type: "none" };
  subject: { type: "application"; id: string; label: string };
};

export type AppNotification = Notification | ApplicationMessage;

export const NotificationContext = createContext<
  (message: string, intent?: NotificationIntent) => void
>(() => undefined);

export function useNotify() {
  return useContext(NotificationContext);
}

export function useMessageNotification(
  message: string | undefined | null,
  intent: NotificationIntent = "error",
) {
  const notify = useNotify();
  const previous = useRef<{ message: string; intent: NotificationIntent } | undefined>(
    undefined,
  );
  useEffect(() => {
    if (!message?.trim()) {
      previous.current = undefined;
      return;
    }
    if (previous.current?.message === message && previous.current.intent === intent) {
      return;
    }
    previous.current = { message, intent };
    notify(message, intent);
  }, [message, intent, notify]);
}

const titles: Record<NotificationIntent, string> = {
  error: "Application error",
  warning: "Application warning",
  info: "Application information",
  success: "Operation succeeded",
};

export function useAppNotifications() {
  // Operation errors may contain sensitive details; never persist this history.
  const [notifications, setNotifications] = useState<ApplicationMessage[]>([]);
  const instanceId = useId();
  const sequence = useRef(0);
  const add = useCallback(
    (message: string, intent: NotificationIntent = "error") => {
      if (!message.trim()) return;
      const id = `app:${instanceId}:${sequence.current++}`;
      const now = new Date().toISOString();
      setNotifications((current) => {
        if (
          current.some(
            (item) => !item.readAt && item.body === message && item.intent === intent,
          )
        ) {
          return current;
        }
        const notification: ApplicationMessage = {
          id,
          sourceKey: id,
          kind: "app_message",
          category: "application",
          intent,
          severity: intent === "success" ? "info" : intent,
          status: "active",
          title: titles[intent],
          body: message,
          subject: { type: "application", id, label: "Application" },
          navigation: { type: "none" },
          data: {},
          createdAt: now,
          updatedAt: now,
          readAt: null,
          dismissedAt: null,
          resolvedAt: null,
        };
        return [notification, ...current].slice(0, 200);
      });
    },
    [instanceId],
  );
  const markRead = useCallback((id: string) => {
    const now = new Date().toISOString();
    setNotifications((current) =>
      current.map((item) =>
        item.id === id && !item.readAt ? { ...item, readAt: now, updatedAt: now } : item,
      ),
    );
  }, []);
  const dismiss = useCallback((id: string) => {
    setNotifications((current) => current.filter((item) => item.id !== id));
  }, []);
  const markAllRead = useCallback(() => {
    const now = new Date().toISOString();
    setNotifications((current) =>
      current.map((item) =>
        item.readAt ? item : { ...item, readAt: now, updatedAt: now },
      ),
    );
  }, []);
  const dismissAll = useCallback(() => setNotifications([]), []);

  return {
    notifications,
    unreadCount: notifications.filter((item) => !item.readAt).length,
    add,
    markRead,
    dismiss,
    markAllRead,
    dismissAll,
  };
}
