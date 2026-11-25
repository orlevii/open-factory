import type { AgentRow } from "@open-factory/db";
import { type Db, schema } from "@open-factory/db";
import type { ProjectResult } from "@open-factory/shared";
import { and, asc, eq } from "drizzle-orm";
import type { RuntimeLog } from "../agents/agent-runtime.ts";
import type { EventBus } from "../agents/event-bus.ts";
import type { EventStore } from "../agents/event-store.ts";
import type { AgentRuntimes } from "../agents/runtimes.ts";
import { cleanupProject } from "./cleanup-project.ts";
import { GitError, GitMissingError, GitTooOldError } from "./git.ts";

// Spec §7.2, §7.3, §7.6. Runs just before a terminated spawned agent's workspace is deleted. It never
// rejects: whatever fails here is logged, and the deletion proceeds.

const MAX_ENTRIES = 20;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export type HostProblem = "missing" | "too_old";

const HOST_LINE: Record<HostProblem, string> = {
  missing: "Couldn't clean up worktrees: git isn't installed on the factory host.",
  too_old: "Couldn't clean up worktrees: git 2.44 or newer is needed on the factory host.",
};

/**
 * The notice's text (also the manager's), or null when nothing was kept and nothing failed. A project's `error` is
 * already the whole sentence after "<project>: ", so it is printed as it is.
 */
export function noticeBody(
  slug: string,
  results: readonly ProjectResult[],
  host?: HostProblem,
): string | null {
  const failed = results.some((r) => r.error) || !!host;
  const nothingToSay = !failed && results.every((r) => r.kept.length === 0);
  if (nothingToSay) return null;

  // One entry per kept branch and per failure; the first MAX_ENTRIES are listed, grouped by project.
  const entries = results.flatMap((r) => [
    ...r.kept.map((k) => ({
      project: r.project,
      kept: true,
      text: `\`${k.branch}\` (${
        k.commits !== undefined
          ? `${plural(k.commits, "commit", "commits")} not pushed or merged`
          : "checked out elsewhere"
      })`,
    })),
    ...(r.error ? [{ project: r.project, kept: false, text: r.error }] : []),
  ]);
  const shown = entries.slice(0, MAX_ENTRIES);
  const lines: string[] = [];
  for (const r of results) {
    const mine = shown.filter((e) => e.project === r.project);
    if (!mine.length) continue;
    const keptText = mine.filter((e) => e.kept).map((e) => e.text);
    const errorText = mine.find((e) => !e.kept)?.text;
    lines.push(
      `${r.project}: ${[...(keptText.length ? [`kept ${keptText.join(", ")}`] : []), ...(errorText ? [errorText] : [])].join("; ")}`,
    );
  }
  const anyRemoved = results.some((r) => r.removed);
  return [
    failed || !anyRemoved
      ? `Couldn't fully clean up @${slug}'s worktrees.`
      : `Cleaned up @${slug}'s worktrees.`,
    ...lines,
    ...(host ? [HOST_LINE[host]] : []),
    ...(entries.length > shown.length
      ? [`and ${entries.length - shown.length} more in @${slug}'s session`]
      : []),
  ].join("\n");
}

/** A sentence-sized reason for the notice: never a git stderr, a host path or more than a short line. */
function short(e: unknown): string {
  if (e instanceof GitError) return `git ${e.args[0] ?? ""} failed`.replace("  ", " ");
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === "string" && /^[A-Z0-9_]{2,30}$/.test(code)) return code;
  if (e instanceof Error) {
    const line = (e.message.split("\n")[0] ?? "").replace(/(?:\/[^\s'"`:,;]*)+/g, "<path>").trim();
    return line.length > 100 ? `${line.slice(0, 100)}…` : line || "unexpected error";
  }
  return "unexpected error";
}

export interface SpawnCleanupDeps {
  db: Db;
  store: Pick<EventStore, "append" | "agentById" | "createHumanMessage" | "createNotice">;
  bus: Pick<EventBus, "publishAll">;
  runtimes: Pick<AgentRuntimes, "adoptNotice">;
  log: RuntimeLog;
  /** Tests inject a fake. */
  cleanupProject?: typeof cleanupProject;
}

export class SpawnCleanup {
  constructor(private readonly d: SpawnCleanupDeps) {}

  /** Never rejects. Idempotent: an agent that already has its `workspace_cleanup` event is skipped (the reaper retries). */
  async run(agent: AgentRow): Promise<void> {
    try {
      const done = await this.d.db
        .select({ id: schema.sessionEvents.id })
        .from(schema.sessionEvents)
        .where(
          and(
            eq(schema.sessionEvents.agentId, agent.id),
            eq(schema.sessionEvents.type, "workspace_cleanup"),
          ),
        )
        .limit(1);
      if (done.length) return;

      // Termination deleted the agent's grants: every registered project is scanned (spec §7.3).
      const projects = await this.d.db
        .select({ name: schema.projects.name, hostPath: schema.projects.hostPath })
        .from(schema.projects)
        .orderBy(asc(schema.projects.name));
      const clean = this.d.cleanupProject ?? cleanupProject;
      const results: ProjectResult[] = [];
      let host: HostProblem | undefined;
      for (const p of projects) {
        try {
          const r = await clean(p, agent.slug);
          if (r) results.push(r);
        } catch (e) {
          if (e instanceof GitMissingError || e instanceof GitTooOldError) {
            host = e instanceof GitMissingError ? "missing" : "too_old";
            break;
          }
          this.d.log.warn(
            { err: e, agent: agent.slug, project: p.name },
            "worktree cleanup failed",
          );
          results.push({
            project: p.name,
            removed: false,
            deleted: [],
            kept: [],
            error: `couldn't clean up: ${short(e)}`,
          });
        }
      }
      if (!results.length && !host) return;

      // The agent is terminated and its journal is empty (the reaper skips agents with one): the single writer.
      // Written even for the host line alone, so a retried sweep doesn't tell twice.
      await this.d.store.append(agent.id, null, { type: "workspace_cleanup", projects: results });

      const body = noticeBody(agent.slug, results, host);
      if (body === null) return;
      await this.d.store.createHumanMessage({
        kind: "system",
        fromAgentId: null,
        notice: "worktrees_kept",
        subjectAgentId: agent.id,
        to: "all",
        body,
        urgent: false,
      });
      this.d.bus.publishAll({ type: "inbox_changed" });

      if (agent.reportsTo) {
        const manager = await this.d.store.agentById(agent.reportsTo);
        if (manager && !manager.archivedAt && !manager.terminatedAt) {
          const row = await this.d.store.createNotice({
            toAgentId: manager.id,
            notice: "worktrees_kept",
            subjectAgentId: agent.id,
            body,
          });
          await this.d.runtimes.adoptNotice(manager.id, row.id);
        }
      }
    } catch (err) {
      this.d.log.error(
        { err, agent: agent.slug },
        "cleaning up a spawned agent's worktrees failed",
      );
    }
  }
}
