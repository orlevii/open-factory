import type { FetchQueryOptions, QueryClient, QueryKey } from "@tanstack/react-query";
import type { ComponentType } from "react";
import { scheduleDetailOptions } from "@/features/schedules/api";
import { agentDetailQueryOptions, agentsListQueryOptions } from "@/features/session/api";
import {
  credentialsQueryOptions,
  projectsQueryOptions,
  secretsQueryOptions,
  usersQueryOptions,
} from "@/features/settings/api";
import { signInQueryOptions } from "@/features/settings/sign-in/api";
import { templateQueryOptions, templatesQueryOptions } from "@/features/templates/api";
import { hostQueryOptions } from "@/lib/host";
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
/** How long an intent prefetch counts as fresh. Hover, press and open each warm the same lists; within this window
 *  only the first fetches. Mounted queries keep their own `staleTime` and refetch on mount as before. */
const PREFETCH_FRESH_MS = 10_000;
function warm<TData, TError, TKey extends QueryKey>(
  qc: QueryClient,
  opts: FetchQueryOptions<TData, TError, TData, TKey>,
) {
  void qc.prefetchQuery({ ...opts, staleTime: PREFETCH_FRESH_MS });
}

export const sheetBodies: { [K in SheetKind]?: Entry } = {
  "new-agent": {
    load: () => import("@/features/agents/new-agent-sheet"),
    // Every list the body reads, together: it suspends on credentials and templates only, the rest fill in.
    prefetch(qc, spec: { template?: string }) {
      warm(qc, templatesQueryOptions);
      warm(qc, credentialsQueryOptions);
      warm(qc, projectsQueryOptions);
      warm(qc, secretsQueryOptions);
      warm(qc, agentsListQueryOptions("exclude"));
      warm(qc, agentsListQueryOptions("only"));
      warm(qc, usersQueryOptions);
      if (spec.template) warm(qc, { ...templateQueryOptions(spec.template), retry: false });
    },
    title: "New agent",
  },
  "edit-agent": {
    load: () => import("@/features/agents/edit-agent-sheet"),
    prefetch(qc, spec: { slug?: string }) {
      if (spec.slug) warm(qc, agentDetailQueryOptions(spec.slug));
      warm(qc, agentsListQueryOptions("exclude"));
      warm(qc, credentialsQueryOptions);
      warm(qc, projectsQueryOptions);
    },
    title: "Edit agent",
  },
  "new-task": {
    load: () => import("@/features/tasks/new-task-sheet"),
    prefetch(qc) {
      warm(qc, agentsListQueryOptions("exclude"));
      warm(qc, agentsListQueryOptions("only"));
    },
    title: "New task",
  },
  "new-schedule": {
    load: () => import("@/features/schedules/new-schedule-sheet"),
    prefetch(qc) {
      warm(qc, agentsListQueryOptions("exclude"));
      warm(qc, agentsListQueryOptions("only"));
    },
    title: "New schedule",
  },
  // Both the top-level sheet and the one stacked over New agent (same kind, told apart by `then`).
  "new-template": {
    load: () => import("@/features/templates/new-template-form"),
    prefetch(qc) {
      warm(qc, templatesQueryOptions);
    },
    title: "New template",
  },
  "add-credential": {
    load: () => import("./setup-sheets").then((m) => ({ default: m.AddCredentialSheet })),
    prefetch(qc) {
      warm(qc, credentialsQueryOptions);
      // A restored attempt never flashes Idle first (spec §8.3).
      warm(qc, signInQueryOptions);
    },
    title: "Add credential",
    note: "Saved to Settings → Credentials; other agents can use it.",
  },
  "add-project": {
    load: () => import("./setup-sheets").then((m) => ({ default: m.AddProjectSheet })),
    prefetch(qc) {
      warm(qc, projectsQueryOptions);
      // Direct, not through `warm`: host info is constant, and `warm` would cap its staleTime at 10s.
      void qc.prefetchQuery(hostQueryOptions);
    },
    title: "Add project",
  },
  "add-secret": {
    load: () => import("./setup-sheets").then((m) => ({ default: m.AddSecretSheet })),
    prefetch(qc) {
      warm(qc, secretsQueryOptions);
    },
    title: "Add secret",
  },
  // Task 17 replaces the placeholder body.
  "sign-in-again": {
    load: () => import("./sign-in-again-sheet-placeholder"),
    prefetch(qc) {
      warm(qc, credentialsQueryOptions);
    },
    title: "Sign in again",
  },
  "edit-schedule": {
    load: () => import("@/features/schedules/edit-schedule-sheet"),
    prefetch(qc, spec: { key: string }) {
      // Edit mode reads the live agents only (the stale-target check and its ended list are create-only).
      warm(qc, scheduleDetailOptions(spec.key));
      warm(qc, agentsListQueryOptions("exclude"));
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
