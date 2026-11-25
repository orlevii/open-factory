import { apiFetch, inboxPageSchema } from "@open-factory/shared";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { postRead, useInboxCache } from "./api";
import { type Burst, burstsOf } from "./notification-copy";

const KEY = "of-notifications";

export const BLOCKED_NOTE =
  "Blocked by your browser. Allow notifications for this site to turn them on.";

/** The `Notification` class whose constructor threw (Android Chrome needs a service worker): unsupported from then on. */
let broken: unknown;
const supported = () => typeof Notification !== "undefined" && Notification !== broken;
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
  const isSupported = useSyncExternalStore(subscribe, supported, () => false);
  const isBlocked = useSyncExternalStore(
    subscribe,
    () => blocked,
    () => false,
  );
  const toggle = useCallback(async () => {
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
  }, []);
  return { supported: isSupported, enabled, blocked: isBlocked, toggle };
}

/**
 * What this tab shows (spec §5.2): one notification per burst, replaced silently while its key stays unread,
 * closed when the key is read or resolved. `seen` holds the newest id of every burst already counted.
 */
export class Notifier {
  private seen = new Set<string>();
  private shown = new Map<string, { tag: string; n: Notification }>();
  private ready = false;

  constructor(private readonly onOpen: (b: Burst) => void) {}

  /** True once what was unread at load (or when the switch turned on) has been taken as not new. */
  get baselined(): boolean {
    return this.ready;
  }

  baseline(bs: Burst[]): void {
    for (const b of bs) this.seen.add(b.newestId);
    this.ready = true;
  }

  update(bs: Burst[], visible: boolean): void {
    const live = new Map(bs.filter((b) => !b.resolved).map((b) => [b.key, b]));
    for (const key of [...this.shown.keys()]) if (!live.has(key)) this.drop(key);
    for (const b of live.values()) {
      if (this.seen.has(b.newestId)) {
        // Partly read elsewhere: the old notification goes, and nothing new arrived to replace it.
        if (this.shown.get(b.key)?.tag !== b.tag) this.drop(b.key);
        continue;
      }
      this.seen.add(b.newestId);
      if (visible || !isOn()) continue;
      if (this.shown.get(b.key)?.tag !== b.tag) this.drop(b.key);
      let n: Notification;
      try {
        n = new Notification(b.title, { body: b.body, tag: b.tag, icon: "/favicon.svg" });
      } catch {
        broken = Notification;
        emit();
        return;
      }
      n.onclick = () => {
        window.focus();
        n.close();
        this.onOpen(b);
      };
      n.onclose = () => {
        if (this.shown.get(b.key)?.n === n) this.shown.delete(b.key);
      };
      this.shown.set(b.key, { tag: b.tag, n });
    }
  }

  closeAll(): void {
    for (const key of [...this.shown.keys()]) this.drop(key);
  }

  /** Sign-out, or the switch turned off: close everything and forget what was seen. */
  reset(): void {
    this.closeAll();
    this.seen.clear();
    this.ready = false;
  }

  private drop(key: string) {
    this.shown.get(key)?.n.close();
    this.shown.delete(key);
  }
}

let openBurst: (b: Burst) => void = () => {};
/** The one notifier of this tab: sign-out (outside the app shell) must reach it, so it is module state. */
const notifier = new Notifier((b) => openBurst(b));
export const setNotifierOpen = (fn: (b: Burst) => void) => {
  openBurst = fn;
};

// One fetch in flight; a frame during it schedules one trailing fetch. A reset invalidates what is in flight.
let generation = 0;
let inFlight = false;
let trailing = false;

export function resetNotifier() {
  generation += 1;
  trailing = false;
  notifier.reset();
}

async function runFetch(): Promise<void> {
  inFlight = true;
  const mine = generation;
  try {
    const page = await apiFetch("/api/inbox?unread=true&notify=true", { schema: inboxPageSchema });
    // The tab's state is read after the await: it may have been hidden, or switched off, meanwhile.
    if (mine !== generation || !isOn()) return;
    const bs = burstsOf({ chats: page.chats ?? [], items: page.items });
    if (notifier.baselined) notifier.update(bs, document.visibilityState === "visible");
    else notifier.baseline(bs);
  } catch {
    // The next frame tries again.
  } finally {
    inFlight = false;
    if (trailing) {
      trailing = false;
      void runFetch();
    }
  }
}

/** A cheap guard first: with the switch off nothing is fetched. */
function requestRefresh() {
  if (!isOn()) return;
  if (inFlight) trailing = true;
  else void runFetch();
}

/** The app shell's half: baseline what is already unread, then react to each `inbox_changed`. */
export function useInboxNotifier() {
  const router = useRouter();
  const cache = useInboxCache();
  const { enabled } = useBrowserNotifications();
  useEffect(() => {
    setNotifierOpen((b) => {
      const query = new URLSearchParams(
        Object.entries(b.open.search ?? {}).map(([k, v]) => [k, String(v)]),
      ).toString();
      void router.navigate({ href: query ? `${b.open.to}?${query}` : b.open.to });
      if (b.itemIds.length === 0) return;
      const ids = new Set(b.itemIds);
      cache.setRead(ids, true, -ids.size);
      for (const id of ids) postRead(id).catch(() => cache.setRead(new Set([id]), false, +1));
    });
    return () => setNotifierOpen(() => {});
  }, [router, cache]);
  // At load, or when the switch is turned on: what is unread now is not "new". Off: close and forget.
  useEffect(() => {
    if (enabled) requestRefresh();
    else resetNotifier();
  }, [enabled]);
  return requestRefresh;
}
