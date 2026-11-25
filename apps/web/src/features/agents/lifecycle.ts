import {
  type AgentSummary,
  ApiError,
  type RestartStatus,
  type ServerMessage,
} from "@open-factory/shared";
import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { z } from "zod";
import { notify } from "@/components/ui/toaster";
import * as api from "@/features/agents/api";
import { restartOutcomeText, showRestartConfirm } from "@/features/agents/restart-confirm";
import { agentDetailQueryOptions, postRestart } from "@/features/session/api";

/**
 * An agent's lifecycle actions (U4 §6.5): Reset persona, Archive and Restore. They run from
 * menus that are gone by the time the server answers, so each toasts its outcome (§10.2), except a
 * Restore whose control is still on screen (`inline`), which hands its failure back instead.
 */

/** "Template x has errors." / "Template x no longer exists." */
export const templateProblemText = (name: string, problem: "invalid" | "missing") =>
  `Template ${name} ${problem === "invalid" ? "has errors." : "no longer exists."}`;

/** The server's reason, or the network's. */
const reason = (err: unknown) =>
  err instanceof ApiError ? err.message : "can't reach the server.";

/** One request per agent and action at a time: a second call while one is in flight sends nothing
 *  and resolves with the first one's result (an inline Restore overlapping a menu Restore reports
 *  that restore's outcome, never a success it didn't see). */
const inFlight = new Map<string, Promise<unknown>>();
function once<T>(key: string, run: () => Promise<T>): Promise<T> {
  const running = inFlight.get(key);
  if (running) return running as Promise<T>;
  const p = run().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

const refresh = (qc: QueryClient, slug: string) =>
  Promise.all([
    qc.invalidateQueries({ queryKey: ["agents"] }),
    qc.invalidateQueries({ queryKey: ["agent", slug] }),
  ]);

/** " Pending messages are sent with the next message." when the restored agent has some queued. */
async function pendingNote(qc: QueryClient, slug: string): Promise<string> {
  try {
    const d = await qc.fetchQuery(agentDetailQueryOptions(slug));
    return d.queue.some((q) => q.kind === "message")
      ? " Pending messages are sent with the next message."
      : "";
  } catch {
    return "";
  }
}

/**
 * Replaces the agent's AGENTS.md with the template's (the caller has confirmed) and toasts the outcome (spec §9):
 * the menu is gone by the time the server answers. A staged reset is not presented as applied.
 */
export async function resetPersona(
  slug: string,
  qc: QueryClient,
  template?: string,
): Promise<void> {
  await once(`reset-persona:${slug}`, async () => {
    try {
      const r = await api.resetPersona(slug);
      notify({
        text:
          r.applied === "on_restart"
            ? `Persona resets when @${slug} restarts.`
            : r.backupDir
              ? "Persona reset. Previous file saved."
              : "Persona reset.",
      });
      void refresh(qc, slug);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : undefined;
      let text = reason(err);
      if ((code === "template_invalid" || code === "template_missing") && template) {
        // The server names what is wrong with the template; the generic line only stands in for a message it
        // didn't send.
        if (!(err instanceof ApiError && err.message))
          text = templateProblemText(template, code === "template_invalid" ? "invalid" : "missing");
        void qc.invalidateQueries({ queryKey: ["templates", template] });
      }
      notify({ text: `Couldn't reset the persona of @${slug}: ${text}` });
    }
  });
}

/**
 * Archives the agent and toasts "Archived @slug." with Undo. Today's behaviour has no confirmation;
 * `confirm`, when given, is asked first and a false answer cancels.
 */
export async function archiveAgent(
  agent: Pick<AgentSummary, "slug">,
  qc: QueryClient,
  {
    confirm,
    onChanged,
  }: {
    confirm?: () => boolean | Promise<boolean>;
    /** After the archive and after its Undo: for a view holding its own copy of the agent. */
    onChanged?: () => void;
  } = {},
): Promise<void> {
  const slug = agent.slug;
  if (confirm && !(await confirm())) return;
  await once(`archive:${slug}`, async () => {
    try {
      await api.archiveAgent(slug);
    } catch (err) {
      // The server's message, whatever the blocker: reports to move, or live spawned agents to
      // terminate (both `has_reports`), each with its own advice.
      notify({ text: `Couldn't archive @${slug}: ${reason(err)}` });
      return;
    }
    void refresh(qc, slug);
    onChanged?.();
    notify({
      text: `Archived @${slug}.`,
      // A failure throws to the toaster, which toasts the server's message.
      undo: async () => {
        await api.unarchiveAgent(slug);
        await refresh(qc, slug);
        onChanged?.();
      },
    });
  });
}

/**
 * Restores an archived agent. From a menu it toasts "Restored @slug." or the failure; `inline` (a
 * Restore button still on screen) toasts nothing. Resolves to the failure text, or undefined when
 * the agent was restored; a call made while a restore is in flight gets that restore's result.
 */
export async function restoreAgent(
  slug: string,
  qc: QueryClient,
  { inline = false, onChanged }: { inline?: boolean; onChanged?: () => void } = {},
): Promise<string | undefined> {
  return once(`restore:${slug}`, async () => {
    try {
      await api.unarchiveAgent(slug);
    } catch (err) {
      const text = `Couldn't restore @${slug}: ${reason(err)}`;
      if (!inline) notify({ text });
      return text;
    }
    const note = inline ? "" : await pendingNote(qc, slug);
    await refresh(qc, slug);
    onChanged?.();
    if (!inline) notify({ text: `Restored @${slug}.${note}` });
    return undefined;
  });
}

// Restart now (I7 §9.4). The latch is a module store, so every Restart button for one agent shares it
// and it outlives the menu or button that started it.
const latch = new Map<string, { responded: boolean; framed: boolean }>();
const latchListeners = new Set<() => void>();
function setLatch(slug: string, next: { responded: boolean; framed: boolean } | undefined) {
  if (next) latch.set(slug, next);
  else if (!latch.delete(slug)) return;
  for (const l of latchListeners) l();
}
const subscribeLatch = (l: () => void) => {
  latchListeners.add(l);
  return () => void latchListeners.delete(l);
};

/** Pending from the click until both the response and the next status frame for the agent are in, or an
 *  `error` event arrives, whichever comes first. */
export const useRestartPending = (slug: string): boolean =>
  useSyncExternalStore(
    subscribeLatch,
    () => latch.has(slug),
    () => false,
  );

/** Fed from the app's WebSocket handler (as the status frames are), never a per-button listener. */
export function onRestartFrame(m: ServerMessage): void {
  if (m.type !== "agent_status" && m.type !== "session_event") return;
  const l = latch.get(m.agent);
  if (!l) return;
  if (m.type === "session_event") {
    if (m.event.event.type === "error") setLatch(m.agent, undefined);
  } else if (l.responded) setLatch(m.agent, undefined);
  else l.framed = true;
}

const lostWorkData = z.object({ tasks: z.array(z.string()), crons: z.array(z.string()) });

/** Forgets every pending restart: a reconnected socket may have dropped the frame that would end one, and a
 *  failing test mustn't leak one into the next. */
export function resetRestartLatch(): void {
  latch.clear();
  for (const l of latchListeners) l();
}

/** The request is in: toast the outcome, end the latch unless a status frame is still due, refresh. */
function settleRestart(slug: string, qc: QueryClient, status: RestartStatus): void {
  notify({ text: restartOutcomeText(slug, status) });
  const l = latch.get(slug);
  // Only a restart that is starting is followed by a status frame.
  if (status !== "restarting" || l?.framed) setLatch(slug, undefined);
  else if (l) l.responded = true;
  void refresh(qc, slug);
}

/** The confirm's "Restart anyway": the same latch, dedupe and refresh as Restart now. A failure throws
 *  to the dialog, which shows it and stays open. */
function forceRestart(slug: string, qc: QueryClient): Promise<void> {
  return once(`restart:${slug}`, async () => {
    setLatch(slug, { responded: false, framed: false });
    try {
      settleRestart(slug, qc, await postRestart(slug, { force: true }));
    } catch (err) {
      setLatch(slug, undefined);
      throw err;
    }
  });
}

/**
 * Restarts the agent now (no force) and toasts the outcome. A 409 `lost_work` opens the confirm; any other
 * failure toasts. The result lands on the agent it was asked for, wherever the asking menu has gone.
 * Resolves whether the restart request succeeded.
 */
export function restartAgentNow(slug: string, qc: QueryClient): Promise<boolean> {
  return once(`restart:${slug}`, async () => {
    setLatch(slug, { responded: false, framed: false });
    try {
      settleRestart(slug, qc, await postRestart(slug));
      return true;
    } catch (err) {
      setLatch(slug, undefined);
      const data =
        err instanceof ApiError && err.code === "lost_work"
          ? lostWorkData.safeParse(err.body.data)
          : undefined;
      if (data?.success)
        showRestartConfirm({ slug, ...data.data, force: () => forceRestart(slug, qc) });
      else notify({ text: `Couldn't restart @${slug}: ${reason(err)}` });
      return false;
    }
  });
}
