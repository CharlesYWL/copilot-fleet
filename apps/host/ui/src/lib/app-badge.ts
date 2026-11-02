/**
 * The Badging API lives on `navigator` only in browsers that implement it, and
 * only does anything visible once the console is installed as an app (Edge or
 * Chrome "Install Copilot Fleet"), where it marks the taskbar or dock icon.
 */
type BadgingNavigator = Navigator & {
  setAppBadge?: (contents?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

/**
 * Mirrors the unread count onto the installed app's icon, beside the `(n)` the
 * document title already carries. Failures are ignored: a badge is a hint, and
 * a browser that refuses one (not installed, permission policy) still has the
 * title and the in-app count.
 */
export const showAppBadge = (unreadCount: number): void => {
  const badging = navigator as BadgingNavigator;
  if (unreadCount > 0) {
    void badging.setAppBadge?.(unreadCount).catch(() => undefined);
    return;
  }
  void badging.clearAppBadge?.().catch(() => undefined);
};
