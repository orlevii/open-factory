import { type AgentSummary, ApiError } from "@open-factory/shared";
import type { QueryClient } from "@tanstack/react-query";
import { notify } from "@/components/ui/toaster";
import * as api from "@/features/agents/api";
import { hasOutput, showOutput } from "@/features/agents/show-output";
import { agentDetailQueryOptions } from "@/features/session/api";

/**
 * An agent's lifecycle actions (U4 §6.5): Re-sync from template, Archive and Restore. They run from
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
      if (code === "template_invalid" || code === "template_missing") {
        // The server names what is wrong with the template; the generic line only stands in for a
        // message it didn't send.
        if (template) {
          if (!(err instanceof ApiError && err.message))
            text = templateProblemText(
              template,
              code === "template_invalid" ? "invalid" : "missing",
            );
          void qc.invalidateQueries({ queryKey: ["templates", template] });
        }
      } else if (code === "plugin_install_failed") {
        text = `Plugin install failed. Some files were already copied (previous versions in state/agents/${slug}/resync/). Fix the template and re-sync again.`;
        const output = (err as ApiError).body.output;
        if (hasOutput(output)) {
          notify({
            text: `Couldn't re-sync @${slug}: ${text}`,
            action: {
              label: "Show output",
              run: () =>
                showOutput({
                  title: "Plugin install output",
                  description: `The output of @${slug}'s failed plugin install.`,
                  output,
                }),
            },
          });
          return;
        }
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
