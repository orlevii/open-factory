import { useSyncExternalStore } from "react";

/** What a top-level create/edit sheet can show. */
export type SheetSpec =
  | { kind: "new-agent"; template?: string }
  | { kind: "edit-agent"; slug: string }
  | { kind: "new-task"; assignee?: string }
  | { kind: "new-schedule"; target?: string }
  | { kind: "edit-schedule"; key: string }
  | { kind: "new-template"; then: "open-editor" };

/** A sheet stacked on top of a parent sheet, returning a name to it. */
export type ChildSpec =
  | { kind: "add-credential" }
  | { kind: "add-project" }
  | { kind: "add-secret"; name: string }
  | { kind: "new-template"; then: "return" };

export type OpenParent = SheetSpec & { id: number; at: string; instant: boolean };
export type OpenChild = ChildSpec & { id: number; parentId: number };
export type SheetState = { parent?: OpenParent; child?: OpenChild };

let state: SheetState = {};
let nextId = 1;
let pathnameSource: () => string = () => window.location.pathname;
const listeners = new Set<() => void>();
const pending = new Map<number, { parentId: number; onDone: (name: string) => void }>();
const opens = new Map<SheetSpec["kind"], number>();

/** How many times a kind has been opened: a late result compares it with the count at submit, to tell whether the
 *  user opened that kind again since (and may have edited its draft). */
export const sheetOpens = (kind: SheetSpec["kind"]) => opens.get(kind) ?? 0;

function set(next: SheetState) {
  state = next;
  for (const l of listeners) l();
}

export const currentPathname = () => pathnameSource();
export function setPathnameSource(fn: () => string) {
  pathnameSource = fn;
}

export function openSheet(spec: SheetSpec, opts?: { instant?: boolean; at?: string }) {
  pending.clear();
  opens.set(spec.kind, sheetOpens(spec.kind) + 1);
  set({
    parent: {
      ...spec,
      id: nextId++,
      at: opts?.at ?? currentPathname(),
      instant: opts?.instant ?? false,
    },
  });
}

export function openChildSheet(spec: ChildSpec, onDone: (name: string) => void) {
  const parent = state.parent;
  if (!parent) {
    if (import.meta.env.MODE === "test")
      throw new Error("openChildSheet needs an open parent sheet");
    return;
  }
  if (state.child) pending.delete(state.child.id);
  const id = nextId++;
  pending.set(id, { parentId: parent.id, onDone });
  set({ parent, child: { ...spec, id, parentId: parent.id } });
}

/** Delivers a child's result, only if the parent instance that opened it is still the open one. */
export function completeChild(childId: number, name: string) {
  const entry = pending.get(childId);
  pending.delete(childId);
  const current = state.child?.id === childId;
  if (current) set({ parent: state.parent });
  if (entry && state.parent?.id === entry.parentId) entry.onDone(name);
}

export function closeChildSheet() {
  if (!state.child) return;
  pending.delete(state.child.id);
  set({ parent: state.parent });
}

export function closeSheet() {
  pending.clear();
  if (!state.parent && !state.child) return;
  set({});
}

/** Sign-out: drop everything, including pending callbacks. */
export function resetSheets() {
  pending.clear();
  if (state.parent || state.child) set({});
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
export const getSheetState = () => state;
export const useSheet = () => useSyncExternalStore(subscribe, getSheetState, getSheetState);
