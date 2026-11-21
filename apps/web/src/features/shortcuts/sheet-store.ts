import { useSyncExternalStore } from "react";

/** Open state of the shortcuts sheet, shared by `?`, the palette's action and the sheet itself. */
let open = false;
const listeners = new Set<() => void>();

export function setShortcutsSheetOpen(next: boolean) {
  if (open === next) return;
  open = next;
  for (const l of listeners) l();
}

export const openShortcutsSheet = () => setShortcutsSheetOpen(true);
export const toggleShortcutsSheet = () => setShortcutsSheetOpen(!open);

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
const get = () => open;

export const useShortcutsSheetOpen = () => useSyncExternalStore(subscribe, get, get);
