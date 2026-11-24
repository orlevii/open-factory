import type { AgentRow } from "@open-factory/db";
import { restartAgentToolSchema } from "@open-factory/shared";
import type { ConfigResolver } from "../../agents/config-resolver.ts";
import {
  AgentArchivedError,
  AgentTerminatedError,
  RecoveryRefusedError,
} from "../../agents/errors.ts";
import type { EventStore } from "../../agents/event-store.ts";
import { restartChanges, restartRuntimeAllowed } from "../../agents/restart-changes.ts";
import type { AgentRuntimes } from "../../agents/runtimes.ts";
import type { Router } from "../../messaging/router.ts";
import {
  callerOf,
  type McpServer,
  type ToolContext,
  type ToolRegistration,
  textResult,
  toolError,
} from "../server.ts";

type RestartAgentDeps = {
  /** The persistent agent holding the token, as the registration built it. */
  caller: AgentRow;
  /** The caller read at call time: `manage_org` is decided from the fresh row (I7 §5.2). */
  loadAgent(id: string): Promise<AgentRow | undefined>;
  /** The target's row by name, read fresh (a runtime's row can be stale). */
  store: Pick<EventStore, "agentBySlug">;
  runtimes: AgentRuntimes;
  resolver: Pick<ConfigResolver, "effective">;
  router: Pick<Router, "send">;
  /** The local gate, read live (`() => localRuntimeAllowed(config)`). */
  localRuntimeAllowed(): boolean;
};

/**
 * `restart_agent(target, note?, force?)` (I7 §9.1, §9.3), registered for PERSISTENT agents only. A direct report is
 * always reachable; with `manage_org`, any live agent. The call returns once `restartNow` has decided; the note goes
 * after it, as an ordinary message from the caller, so the target reads the restart notice first.
 */
export function restartAgentTool(d: RestartAgentDeps): ToolRegistration {
  return {
    register(server: McpServer) {
      server.registerTool(
        "restart_agent",
        {
          description:
            "Restart a direct report: it recovers an errored one, or applies its new configuration now. It's refused when background work would be lost, unless you pass force: true. A note is delivered as a message from you.",
          inputSchema: restartAgentToolSchema,
        },
        async (args: { target: string; note?: string; force?: boolean }, tctx: ToolContext) => {
          if (callerOf(tctx) !== d.caller.id)
            throw new Error("restart_agent was built for another caller");
          const wanted = args.target.trim().replace(/^@/, "");
          const manageOrg = (await d.loadAgent(d.caller.id))?.manageOrg === true;
          const row = await d.store.agentBySlug(wanted);
          const label = `@${wanted}`;
          if (!row) {
            return toolError(
              manageOrg ? `No agent named ${label}.` : `${label} isn't one of your direct reports.`,
            );
          }
          if (row.id === d.caller.id)
            return toolError(
              "Your config changes apply when you're idle; you can't restart yourself.",
            );
          if (row.reportsTo !== d.caller.id && !manageOrg)
            return toolError(`${label} isn't one of your direct reports.`);
          if (row.archivedAt) return toolError(`${label} is archived and can't receive messages.`);
          if (row.terminatedAt)
            return toolError(`${label} was terminated and can't receive messages.`);

          const rt = await d.runtimes.load(row.id);
          if (!rt) throw new Error(`No runtime for ${label}`);
          const runtimeAllowed = restartRuntimeAllowed(row, d.localRuntimeAllowed());
          // An errored report is restarted by starting a process at once, which would take the first batch before a
          // note sent afterwards. So its note goes first, as a pending message: the restart notice sorts ahead of it
          // and both reach the new process in one batch (AC 11). Only when the restart can be accepted, so a
          // refusal never leaves a note behind.
          const noteFirst =
            args.note !== undefined &&
            runtimeAllowed &&
            rt.live().status === "errored" &&
            rt.live().errorKind !== "resume_unrecoverable";
          try {
            const early = noteFirst ? await sendNote(d, row.slug, args.note as string) : undefined;
            const outcome = await rt.restartNow({
              by: `@${d.caller.slug}`,
              force: args.force ?? false,
              // Computed here, outside the runtime's job: the resolver reads the disk (I7 §9.2).
              changes: await restartChanges(d, row),
              // A local runtime disabled in this factory is refused, as the human Restart is (I7 §9.2).
              runtimeAllowed,
            });
            // `send` reports a refusal or a failed wake in `results`; it doesn't throw. A lost instruction is
            // surfaced, so the caller doesn't believe it was delivered (the restart itself has happened).
            const lost = noteFirst
              ? early
              : args.note
                ? await sendNote(d, row.slug, args.note)
                : undefined;
            return textResult({
              target: `@${row.slug}`,
              status: outcome.status,
              ...(outcome.note ? { note: outcome.note } : {}),
              ...(lost ? { note_delivered: false, note_error: lost } : {}),
            });
          } catch (e) {
            if (e instanceof RecoveryRefusedError) return toolError(e.message);
            if (e instanceof AgentArchivedError)
              return toolError(`${label} is archived and can't receive messages.`);
            if (e instanceof AgentTerminatedError)
              return toolError(`${label} was terminated and can't receive messages.`);
            throw e;
          }
        },
      );
    },
  };
}

/** Sends the caller's note; returns a path-free sentence when it wasn't accepted, else undefined. */
async function sendNote(d: RestartAgentDeps, slug: string, note: string) {
  const { results } = await d.router.send({ agentId: d.caller.id }, [slug], note, false);
  const r = results[0];
  if (!r) return `Your note to @${slug} wasn't delivered.`;
  if (r.status === "refused") return `Your note wasn't delivered: ${r.reason}`;
  if (r.status === "start_failed") return `Your note is queued, but @${slug} couldn't be started.`;
  return undefined;
}
