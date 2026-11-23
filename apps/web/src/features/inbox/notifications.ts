import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { homeInboxQueryOptions, type InboxItem, useOpenItem } from "./api";

const KEY = "of-notifications";
const PREVIEW_CAP = 120;

export const BLOCKED_NOTE =
  "Blocked by your browser. Allow notifications for this site to turn them on.";

const supported = () => typeof Notification !== "undefined";
const listeners = new Set<() => void>();
const emit = () => {
  for (const fn of listeners) fn();
};
const read = (): boolean => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
};
const write = (on: boolean) => {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {}
  emit();
};
let blocked = false;
const setBlocked = (b: boolean) => {
  blocked = b;
  emit();
};

/** On only while this browser said yes and still allows it: a permission revoked later reads as off. */
const isOn = () => supported() && read() && Notification.permission === "granted";

/**
 * The opt-in switch (UI design §10): per browser, in `localStorage` (never required: private windows may refuse it).
 * `toggle` must run from a click, since turning on calls `Notification.requestPermission()`.
 */
export function useBrowserNotifications() {
  const subscribe = useCallback((fn: () => void) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  const enabled = useSyncExternalStore(subscribe, isOn, () => false);
  const isBlocked = useSyncExternalStore(
    subscribe,
    () => blocked,
    () => false,
  );
  async function toggle() {
    if (!supported()) return;
    if (isOn()) {
      setBlocked(false);
      return write(false);
    }
    const permission =
      Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (permission === "granted") {
      setBlocked(false);
      write(true);
    } else {
      setBlocked(true);
    }
  }
  return { supported: supported(), enabled, blocked: isBlocked, toggle };
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const cap = (s: string) => (s.length > PREVIEW_CAP ? `${s.slice(0, PREVIEW_CAP - 1)}…` : s);

/** UI design §10's titles. Plain text only; agent text never becomes a URL or markup here. */
export function notificationTitle(i: InboxItem): string {
  if (i.kind === "mention")
    return `@${i.from.name} mentioned you${i.task ? ` on ${i.task.key}` : ""}`;
  if (i.kind === "task_event")
    return `${i.task?.key ?? "A task"} ${i.fact === "cancelled" ? "was cancelled" : "is done"}`;
  if (i.from.kind === "factory") return `Factory${i.about ? ` about @${i.about}` : ""}`;
  return `@${i.from.name} messaged you`;
}

/**
 * One notification per unread item not seen before in this tab, only while the tab is hidden and the switch is on.
 * `tag` is the item id, so several open tabs collapse into one. `seen` is updated either way.
 */
export function notifyNewItems(
  items: InboxItem[],
  seen: Set<string>,
  onOpen: (item: InboxItem) => void,
) {
  const show = isOn() && document.visibilityState === "hidden";
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    if (!show || item.read) continue;
    const n = new Notification(notificationTitle(item), {
      body: cap(oneLine(item.preview)),
      tag: item.id,
      icon: "/favicon.svg",
    });
    n.onclick = () => {
      window.focus();
      n.close();
      onOpen(item);
    };
  }
}

/** The app shell's half: baseline what is already unread, then notify on each `inbox_changed`. */
export function useInboxNotifier() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const open = useOpenItem();
  const { enabled } = useBrowserNotifications();
  const seen = useRef<Set<string> | null>(null);
  const fetchUnread = useCallback(
    () => qc.fetchQuery({ ...homeInboxQueryOptions, staleTime: 0 }).then((p) => p.items),
    [qc],
  );
  const onOpen = useCallback(
    (item: InboxItem) => {
      open(item);
      const l = item.link;
      if (l.kind === "task")
        void navigate({
          to: "/tasks/$key",
          params: { key: l.key },
          search: l.commentId ? { comment: l.commentId } : {},
        });
      else
        void navigate({
          to: "/agents/$slug/session",
          params: { slug: l.agentSlug },
          search: l.seq === undefined ? undefined : { event: l.seq },
        });
    },
    [open, navigate],
  );
  // Baseline when the switch is on (at load, or when it is turned on): what is unread now is not "new".
  useEffect(() => {
    if (!enabled) {
      seen.current = null;
      return;
    }
    let live = true;
    fetchUnread().then(
      (items) => {
        if (live && !seen.current) seen.current = new Set(items.map((i) => i.id));
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [enabled, fetchUnread]);
  return useCallback(() => {
    if (!isOn() || !seen.current) return;
    const set = seen.current;
    fetchUnread().then(
      (items) => notifyNewItems(items, set, onOpen),
      () => {},
    );
  }, [fetchUnread, onOpen]);
}
