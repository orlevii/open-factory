import type { QueryClient } from "@tanstack/react-query";
import type { ComponentType } from "react";
import { scheduleDetailOptions } from "@/features/schedules/api";
import { agentDetailQueryOptions, agentsListQueryOptions } from "@/features/session/api";
import {
  credentialsQueryOptions,
  projectsQueryOptions,
  secretsQueryOptions,
  usersQueryOptions,
} from "@/features/settings/api";
import { templateQueryOptions, templatesQueryOptions } from "@/features/templates/api";
import type { ChildSpec, SheetSpec } from "./sheet-store";

export type BodyProps<S> = { spec: S; sheetId: number; close(): void };
export type SheetKind = SheetSpec["kind"] | ChildSpec["kind"];

type Entry = {
  load: () => Promise<{ default: ComponentType<BodyProps<any>> }>;
  /** Starts the body's queries (every list or detail it reads), so data and chunk load in parallel. */
  prefetch(qc: QueryClient, spec: any): void;
  /** A string, or a function of the spec (edit-schedule's title is the schedule key). */
  title: string | ((spec: any) => string);
  /** Classes for the title (edit-schedule shows its key in mono). */
  titleClass?: string;
  /** A stacked child's line after "For <parent>." in its description. */
  note?: string;
};

/** kind → lazy body. PR1 registers new-task, new-schedule and edit-schedule; PR2 the rest. */
export const sheetBodies: { [K in SheetKind]?: Entry } = {
  "new-agent": {
    load: () => import("@/features/agents/new-agent-sheet"),
    // Every list the body reads, together: it suspends on credentials and templates only, the rest fill in.
    prefetch(qc, spec: { template?: string }) {
      void qc.prefetchQuery(templatesQueryOptions);
      void qc.prefetchQuery(credentialsQueryOptions);
      void qc.prefetchQuery(projectsQueryOptions);
      void qc.prefetchQuery(secretsQueryOptions);
      void qc.prefetchQuery(agentsListQueryOptions("exclude"));
      void qc.prefetchQuery(agentsListQueryOptions("only"));
      void qc.prefetchQuery(usersQueryOptions);
      if (spec.template)
        void qc.prefetchQuery({ ...templateQueryOptions(spec.template), retry: false });
    },
    title: "New agent",
  },
  "edit-agent": {
    load: () => import("@/features/agents/edit-agent-sheet"),
    prefetch(qc, spec: { slug?: string }) {
      if (spec.slug) void qc.prefetchQuery(agentDetailQueryOptions(spec.slug));
      void qc.prefetchQuery(agentsListQueryOptions("exclude"));
      void qc.prefetchQuery(credentialsQueryOptions);
      void qc.prefetchQuery(projectsQueryOptions);
    },
    title: "Edit agent",
  },
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
  // Both the top-level sheet and the one stacked over New agent (same kind, told apart by `then`).
  "new-template": {
    load: () => import("@/features/templates/new-template-form"),
    prefetch(qc) {
      void qc.prefetchQuery(templatesQueryOptions);
    },
    title: "New template",
  },
  "add-credential": {
    load: () => import("./setup-sheets").then((m) => ({ default: m.AddCredentialSheet })),
    prefetch(qc) {
      void qc.prefetchQuery(credentialsQueryOptions);
    },
    title: "Add credential",
    note: "Saved to Settings → Credentials; other agents can use it.",
  },
  "add-project": {
    load: () => import("./setup-sheets").then((m) => ({ default: m.AddProjectSheet })),
    prefetch(qc) {
      void qc.prefetchQuery(projectsQueryOptions);
    },
    title: "Add project",
  },
  "add-secret": {
    load: () => import("./setup-sheets").then((m) => ({ default: m.AddSecretSheet })),
    prefetch(qc) {
      void qc.prefetchQuery(secretsQueryOptions);
    },
    title: "Add secret",
  },
  "edit-schedule": {
    load: () => import("@/features/schedules/edit-schedule-sheet"),
    prefetch(qc, spec: { key: string }) {
      void qc.prefetchQuery(scheduleDetailOptions(spec.key));
      void qc.prefetchQuery(agentsListQueryOptions("exclude"));
      void qc.prefetchQuery(agentsListQueryOptions("only"));
    },
    title: (spec: { key: string }) => spec.key,
    titleClass: "font-mono",
  },
};

export function sheetTitle(kind: SheetKind, spec: SheetSpec | ChildSpec): string {
  const t = sheetBodies[kind]?.title;
  return typeof t === "function" ? t(spec) : (t ?? "");
}

export const sheetTitleClass = (kind: SheetKind) => sheetBodies[kind]?.titleClass;

/** A stacked child's description: whom it serves ("For New agent."), then its own note. */
export function childDescription(kind: SheetKind, parentTitle: string): string {
  const note = sheetBodies[kind]?.note;
  return note ? `For ${parentTitle}. ${note}` : `For ${parentTitle}.`;
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

/** An entry point's intent handlers (hover, focus, pointerdown): each preloads the sheet's chunk and data. */
export function sheetIntent(kind: SheetKind, spec?: SheetSpec | ChildSpec) {
  const preload = () => preloadSheet(kind, spec);
  return { onPointerEnter: preload, onFocus: preload, onPointerDown: preload };
}

/** Idle after first paint: chunks only (a spec is needed to know which data to read). */
export function preloadAllSheets() {
  for (const entry of Object.values(sheetBodies)) {
    if (entry) void loadBody(entry).catch(() => {});
  }
}
