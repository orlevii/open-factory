import type { RestartStatus } from "@open-factory/shared";
import { useSyncExternalStore } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";

/**
 * The lost-work confirm of Restart now (I7 §9.4). Its state is a module store read with
 * `useSyncExternalStore` and set from the async result, never from props: a 409 that arrives after the
 * menu that asked has closed, unmounted or moved to another agent still opens it for the original agent.
 */

type Open = {
  ref: string;
  handle: string;
  tasks: string[];
  crons: string[];
  /** "Restart anyway": the forced restart, run by the lifecycle (which holds the query client). */
  force: () => Promise<void>;
};
type State = { open: boolean; shown: Open | undefined; returnTo: HTMLElement | null };

let state: State = { open: false, shown: undefined, returnTo: null };
const listeners = new Set<() => void>();
const set = (next: State) => {
  state = next;
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
const getState = () => state;

/** Opens the confirm for the agent. Focus returns to what has it now (the ⋯ the menu handed back to), if it's still there. */
export function showRestartConfirm(o: Open): void {
  const at = document.activeElement;
  set({ open: true, shown: o, returnTo: at instanceof HTMLElement ? at : null });
}

const MAX_LISTED = 5;
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** The dialog's sentence and its lists: at most 5 each, then how many more. Nothing is said about an empty list. */
export function lostWorkBody(handle: string, tasks: string[], crons: string[]) {
  const named = tasks.length <= MAX_LISTED ? ` (${tasks.join(", ")})` : "";
  const parts = [
    ...(tasks.length > 0 ? [`${count(tasks.length, "background task")}${named}`] : []),
    ...(crons.length > 0 ? [count(crons.length, "cron")] : []),
  ];
  return {
    text: `@${handle} has ${parts.join(" and ")}. Restarting stops them.`,
    tasks: tasks.slice(0, MAX_LISTED),
    crons: crons.slice(0, MAX_LISTED),
    moreTasks: Math.max(0, tasks.length - MAX_LISTED),
    moreCrons: Math.max(0, crons.length - MAX_LISTED),
  };
}

const OUTCOME: Record<RestartStatus, (handle: string) => string> = {
  restarting: (s) => `Restarting @${s}.`,
  restart_pending: (s) => `Restarts @${s} when its task results are in.`,
  restarted_idle: (s) => `@${s} restarted; its next start uses the latest config.`,
  not_running: (s) => `@${s} isn't running; its next start uses the latest config.`,
};
export const restartOutcomeText = (handle: string, status: RestartStatus) =>
  OUTCOME[status](handle);

function List({ items, more, kind }: { items: string[]; more: number; kind: string }) {
  if (items.length === 0) return null;
  return (
    <ul className="grid gap-1 font-mono text-[0.8125rem] [overflow-wrap:anywhere]">
      {items.map((item, i) => (
        // Free text isn't a key: two tasks can read the same.
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed snapshot, never reordered
        <li key={`${kind}-${i}`}>{item}</li>
      ))}
      {more > 0 && <li className="text-muted-foreground">and {more} more</li>}
    </ul>
  );
}

/** Mounted once in the app layout, beside the sheet host. */
export function RestartConfirmHost() {
  const { open, shown, returnTo } = useSyncExternalStore(subscribe, getState, getState);
  if (!shown) return null;
  const { handle } = shown;
  const body = lostWorkBody(handle, shown.tasks, shown.crons);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(o) => set({ ...state, open: o })}
      title={`Restart @${handle} now?`}
      body={body.text}
      detail={
        <>
          <List items={body.tasks} more={body.moreTasks} kind="task" />
          <List items={body.crons} more={body.moreCrons} kind="cron" />
        </>
      }
      confirmLabel="Restart anyway"
      pendingLabel="Restarting…"
      onConfirm={shown.force}
      onCloseAutoFocus={(e) => {
        if (!returnTo?.isConnected) return;
        e.preventDefault();
        returnTo.focus();
      }}
    />
  );
}
