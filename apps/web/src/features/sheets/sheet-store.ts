import { useSyncExternalStore } from "react";

/** What a top-level create/edit sheet can show. */
export type SheetSpec =
  | { kind: "new-agent"; template?: string }
  | { kind: "edit-agent"; agentRef: string }
  | { kind: "new-task"; assignee?: string }
  | { kind: "new-schedule"; target?: string }
  | { kind: "edit-schedule"; key: string }
  | { kind: "new-template"; then: "open-editor" }
  | { kind: "sign-in-again"; name: string }
  | { kind: "add-skills" };

/** A sheet stacked on top of a parent sheet, returning a name to it. */
export type ChildSpec =
  | { kind: "add-credential" }
  | { kind: "add-secret"; name: string }
  | { kind: "new-template"; then: "return" };

/** A parent layer: a top-level sheet, or a setup sheet a page opened for a result (`openSheetForResult`). */
export type OpenParent = (SheetSpec | ChildSpec) & { id: number; at: string; instant: boolean };
export type OpenChild = ChildSpec & { id: number; parentId: number };
export type SheetState = { parent?: OpenParent; child?: OpenChild };

let state: SheetState = {};
let nextId = 1;
let pathnameSource: () => string = () => window.location.pathname;
const listeners = new Set<() => void>();
const pending = new Map<number, { parentId: number; onDone: (name: string) => void }>();
// Where focus lands when a child that served its parent closes (set by the parent's `onDone`).
let childReturnFocus: (() => HTMLElement | null) | undefined;

function set(next: SheetState) {
  state = next;
  for (const l of listeners) l();
}

export const currentPathname = () => pathnameSource();
export function setPathnameSource(fn: () => string) {
  pathnameSource = fn;
}

export function openSheet(spec: SheetSpec, opts?: { instant?: boolean; at?: string }) {
  openParent(spec, opts);
}

function openParent(
  spec: SheetSpec | ChildSpec,
  opts?: { instant?: boolean; at?: string },
): number {
  pending.clear();
  const id = nextId++;
  set({
    parent: {
      ...spec,
      id,
      at: opts?.at ?? currentPathname(),
      instant: opts?.instant ?? false,
    },
  });
  return id;
}

export function openChildSheet(spec: ChildSpec, onDone: (name: string) => void) {
  const parent = state.parent;
  if (!parent) {
    if (import.meta.env.MODE === "test")
      throw new Error("openChildSheet needs an open parent sheet");
    return;
  }
  if (state.child) pending.delete(state.child.id);
  childReturnFocus = undefined;
  const id = nextId++;
  pending.set(id, { parentId: parent.id, onDone });
  set({ parent, child: { ...spec, id, parentId: parent.id } });
}

/**
 * A setup sheet (Add secret) opened from a page for its result: it stacks on an open parent sheet, else it opens as
 * the parent layer and serves itself. `onDone` gets the new name; closing without one drops it.
 */
export function openSheetForResult(spec: ChildSpec, onDone: (name: string) => void) {
  if (state.parent) {
    openChildSheet(spec, onDone);
    return;
  }
  const id = openParent(spec);
  pending.set(id, { parentId: id, onDone });
}

/** Delivers a child's result, only if the parent instance that opened it is still the open one. A parent layer
 *  opened for a result (`openSheetForResult`) serves itself: it closes, then delivers. */
export function completeChild(childId: number, name: string) {
  const entry = pending.get(childId);
  pending.delete(childId);
  const serves = entry !== undefined && state.parent?.id === entry.parentId;
  if (state.child?.id === childId) set({ parent: state.parent });
  else if (state.parent?.id === childId) set({});
  if (serves) entry.onDone(name);
}

/** Called from a parent's `onDone`: the child's close focuses this (looked up on close, after the value rendered)
 *  instead of the button that opened it. */
export function returnFocusAfterChild(target: () => HTMLElement | null) {
  childReturnFocus = target;
}
/** The child layer's close: the target the parent named, once. */
export function takeChildReturnFocus(): HTMLElement | null {
  const t = childReturnFocus;
  childReturnFocus = undefined;
  return t?.() ?? null;
}

export function closeChildSheet() {
  if (!state.child) return;
  pending.delete(state.child.id);
  set({ parent: state.parent });
}

export function closeSheet() {
  pending.clear();
  childReturnFocus = undefined;
  if (!state.parent && !state.child) return;
  set({});
}

/** Sign-out: drop everything, including pending callbacks. */
export function resetSheets() {
  pending.clear();
  childReturnFocus = undefined;
  if (state.parent || state.child) set({});
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
export const getSheetState = () => state;
export const useSheet = () => useSyncExternalStore(subscribe, getSheetState, getSheetState);
