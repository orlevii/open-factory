import type { QueryClient } from "@tanstack/react-query";
import type { ComponentType } from "react";
import { agentsListQueryOptions } from "@/features/session/api";
import type { ChildSpec, SheetSpec } from "./sheet-store";

export type BodyProps<S> = { spec: S; sheetId: number; close(): void };
export type SheetKind = SheetSpec["kind"] | ChildSpec["kind"];

type Entry = {
  load: () => Promise<{ default: ComponentType<BodyProps<any>> }>;
  /** Starts the body's queries (every list or detail it reads), so data and chunk load in parallel. */
  prefetch(qc: QueryClient, spec: any): void;
  /** A string, or a function of the spec (edit-schedule's title is the schedule key). */
  title: string | ((spec: any) => string);
};

/** kind → lazy body. PR1 registers new-task, new-schedule and edit-schedule; PR2 the rest. */
export const sheetBodies: { [K in SheetKind]?: Entry } = {
  "new-task": {
    load: () => import("@/features/tasks/new-task-sheet"),
    prefetch(qc) {
      void qc.prefetchQuery(agentsListQueryOptions("exclude"));
      void qc.prefetchQuery(agentsListQueryOptions("only"));
    },
    title: "New task",
  },
  "new-schedule": {
    load: () => import("@/features/schedules/new-schedule-sheet"),
    prefetch(qc) {
      void qc.prefetchQuery(agentsListQueryOptions("exclude"));
      void qc.prefetchQuery(agentsListQueryOptions("only"));
    },
    title: "New schedule",
  },
};

export function sheetTitle(kind: SheetKind, spec: SheetSpec | ChildSpec): string {
  const t = sheetBodies[kind]?.title;
  return typeof t === "function" ? t(spec) : (t ?? "");
}

/** Forget a failed (or any) load so the next render imports again. */
export function resetBodyLoad(entry: Entry) {
  loads.delete(entry);
}

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
