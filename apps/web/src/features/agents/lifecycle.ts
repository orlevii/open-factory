import { type AgentSummary, ApiError } from "@open-factory/shared";
import type { QueryClient } from "@tanstack/react-query";
import { notify } from "@/components/ui/toaster";
import * as api from "@/features/agents/api";
import { agentDetailQueryOptions } from "@/features/session/api";

/**
 * An agent's lifecycle actions (U4 §6.5): Re-sync from template, Archive and Restore. They run from
 * menus that are gone by the time the server answers, so each toasts its outcome (§10.2), except a
 * Restore whose control is still on screen (`inline`), which hands its failure back instead.
 */

/** "Template x has errors." / "Template x no longer exists." */
export const templateProblemText = (name: string, problem: "invalid" | "missing") =>
  `Template ${name} ${problem === "invalid" ? "has errors." : "no longer exists."}`;

/** "@a and @b report to this agent. Change their manager first." */
export function reportsText(reports: string[]): string {
  const names = reports.map((r) => `@${r}`);
  const list =
    names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${list} ${reports.length === 1 ? "reports" : "report"} to this agent. Change their manager first.`;
}

/** The server's reason, or the network's. */
const reason = (err: unknown) =>
  err instanceof ApiError ? err.message : "can't reach the server.";

/** One request per agent and action at a time: a second click while one is in flight does nothing. */
const inFlight = new Set<string>();
async function once<T>(key: string, run: () => Promise<T>): Promise<T | undefined> {
  if (inFlight.has(key)) return undefined;
  inFlight.add(key);
  try {
    return await run();
  } finally {
    inFlight.delete(key);
  }
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

/** Copies the template over the agent's files (no confirmation, as before) and toasts the outcome. */
export async function resyncAgent(slug: string, qc: QueryClient, template?: string): Promise<void> {
  await once(`resync:${slug}`, async () => {
    try {
      const r = await api.resyncAgent(slug);
      // Staged while the agent runs: nothing looks applied before it is (spec §11.4).
      notify({
        text:
          r.applied === "on_restart"
            ? `Re-synced. The changes apply when @${slug} restarts (when idle).`
            : r.backupDir
              ? `Re-synced. Previous files saved in ${r.backupDir}.`
              : "Re-synced. Nothing differed.",
      });
      void refresh(qc, slug);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : undefined;
      let text = reason(err);
      if ((code === "template_invalid" || code === "template_missing") && template) {
        text = templateProblemText(template, code === "template_invalid" ? "invalid" : "missing");
        void qc.invalidateQueries({ queryKey: ["templates", template] });
      } else if (code === "plugin_install_failed") {
        text = `Plugin install failed. Some files were already copied (previous versions in state/agents/${slug}/resync/). Fix the template and re-sync again.`;
      }
      notify({ text: `Couldn't re-sync @${slug}: ${text}` });
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
      const reports = err instanceof ApiError ? err.body.reports : undefined;
      const text =
        err instanceof ApiError && err.code === "has_reports" && Array.isArray(reports)
          ? reportsText(reports.map(String))
          : reason(err);
      notify({ text: `Couldn't archive @${slug}: ${text}` });
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
 * the agent was restored (or a restore was already in flight).
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
