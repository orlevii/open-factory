import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}
const getSnapshot = () => !document.hidden;
const getServerSnapshot = () => true;

/** Whether the tab is visible: one shared subscription shape for every ticking or polling component. */
export function useDocumentVisible(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
