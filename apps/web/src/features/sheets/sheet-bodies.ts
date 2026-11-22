import type { QueryClient } from "@tanstack/react-query";
import type { ComponentType } from "react";
import type { ChildSpec, SheetSpec } from "./sheet-store";

export type BodyProps<S> = { spec: S; sheetId: number; close(): void };
export type SheetKind = SheetSpec["kind"] | ChildSpec["kind"];

type Entry = {
  load: () => Promise<{ default: ComponentType<BodyProps<any>> }>;
  /** Starts the body's queries (every list or detail it reads), so data and chunk load in parallel. */
  prefetch(qc: QueryClient, spec: any): void;
  title: string;
};

/** kind → lazy body. PR1 registers new-task, new-schedule and edit-schedule; PR2 the rest. */
export const sheetBodies: { [K in SheetKind]?: Entry } = {};

let queryClient: QueryClient | undefined;
/** Bound by the host, so `preloadSheet` can be called from any entry point. */
export function bindSheetQueryClient(qc: QueryClient | undefined) {
  queryClient = qc;
}

// One import per entry, shared by the lazy component and every preload; a failed load can be retried.
const loads = new WeakMap<Entry, ReturnType<Entry["load"]>>();
export function loadBody(entry: Entry) {
  let p = loads.get(entry);
  if (!p) {
    p = entry.load();
    loads.set(entry, p);
    p.catch(() => loads.delete(entry));
  }
  return p;
}

/** On intent (hover, focus, pointerdown) and on every open: the chunk and the body's queries, in parallel. */
export function preloadSheet(kind: SheetKind, spec?: SheetSpec | ChildSpec) {
  const entry = sheetBodies[kind];
  if (!entry) return;
  void loadBody(entry).catch(() => {});
  if (queryClient) entry.prefetch(queryClient, spec ?? { kind });
}

/** Idle after first paint: chunks only (a spec is needed to know which data to read). */
export function preloadAllSheets() {
  for (const entry of Object.values(sheetBodies)) {
    if (entry) void loadBody(entry).catch(() => {});
  }
}
