import type { AgentRow } from "@open-factory/db";
import { neutraliseEnvelopeTags } from "@open-factory/harness";
import {
  classifyInput,
  hasLineBreak,
  MAX_BODY_BYTES,
  MAX_FOCUS_CHARS,
  sendCommandToolSchema,
} from "@open-factory/shared";
import { commandList } from "../../agents/commands.ts";
import { SelfCommandPendingError } from "../../agents/errors.ts";
import type { EventStore } from "../../agents/event-store.ts";
import type { AgentRuntimes } from "../../agents/runtimes.ts";
import type { Neighborhood } from "../../messaging/neighborhood.ts";
import {
  callerOf,
  type McpServer,
  type ToolContext,
  type ToolRegistration,
  textResult,
  toolError,
} from "../server.ts";

const utf8 = new TextEncoder();

/**
 * `send_command(target, command)` (I1 §7): a slash command for yourself or a direct report (spawned agents included).
 * Registered for every caller; a spawned agent's version says "only yourself" and refuses any other target. The entry
 * is the caller's own (`by: "@caller"`, `self` when it targets itself): no human sender, so nobody can cancel it.
 */
export function sendCommandTool(d: {
  caller: AgentRow;
  neighborhood: Neighborhood;
  runtimes: AgentRuntimes;
  store: Pick<EventStore, "agentBySlug" | "agentCommands">;
  spawned: boolean;
}): ToolRegistration {
  return {
    register(server: McpServer) {
      server.registerTool(
        "send_command",
        {
          description: d.spawned
            ? 'Run a slash command in your own session, e.g. "/compact". The target is "me": only yourself. It runs when your current turn ends.'
            : 'Run a slash command in your own session or a direct report\'s, e.g. "/compact". The target is "me", your own handle or a direct report\'s handle. It runs when the target\'s current turn ends.',
          inputSchema: sendCommandToolSchema,
        },
        async (args: { target: string; command: string }, tctx: ToolContext) => {
          const me = callerOf(tctx);
          if (me !== d.caller.id) throw new Error("send_command was built for another caller");
          const command = args.command.trim();
          if (!command.startsWith("/")) return toolError("A command starts with /.");
          if (hasLineBreak(command)) return toolError("A command must be one line.");
          if (utf8.encode(command).length > MAX_BODY_BYTES)
            return toolError("A command is larger than 64 KB.");

          const wanted = args.target.trim().replace(/^@/, "");
          const label = `@${wanted || args.target.trim()}`;
          const self = wanted === "me" || wanted === d.caller.slug;
          let target: AgentRow | undefined;
          if (self) target = d.caller;
          else {
            if (d.spawned)
              return toolError(`${label} isn't you; you can only send a command to yourself.`);
            const row = await d.store.agentBySlug(wanted);
            if (row && row.reportsTo === d.caller.id) {
              if (row.archivedAt)
                return toolError(`${label} is archived and can't receive messages.`);
              if (row.terminatedAt)
                return toolError(`${label} was terminated and can't receive messages.`);
              target = row;
            }
          }
          if (!target) return toolError(`${label} isn't you or one of your direct reports.`);

          const known = new Set(
            commandList(
              (await d.store.agentCommands(target.id))?.commands,
              target.config.skills,
            ).flatMap((c) => [c.name, ...(c.aliases ?? [])].map((n) => n.toLowerCase())),
          );
          const cls = classifyInput(command, known);
          if (cls.kind === "command" && cls.denied) return toolError(cls.denied);
          if (cls.kind === "command" && cls.name === "compact" && cls.args.length > MAX_FOCUS_CHARS)
            return toolError(`The compact focus is longer than ${MAX_FOCUS_CHARS} characters.`);

          const rt = await d.runtimes.bySlug(target.slug);
          if (!rt) return toolError(`${label} isn't you or one of your direct reports.`);
          const live = rt.live();
          const note = noteFor({
            self,
            name:
              cls.kind === "command" ? cls.name : (command.split(/\s/, 1)[0] ?? command).slice(1),
            slug: target.slug,
            errored: live.status === "errored",
            turnOpen: live.turnOpen,
            idle: live.status === "idle",
          });
          try {
            if (cls.kind === "command" && cls.name === "compact")
              await rt.compact({
                ...(cls.args.trim() ? { focus: cls.args.trim() } : {}),
                byHandle: d.caller.slug,
                ...(self ? { self: true } : {}),
              });
            else
              await rt.rawInput({
                text: neutraliseEnvelopeTags(command),
                by: `@${d.caller.slug}`,
                ...(self ? { self: true } : {}),
              });
          } catch (e) {
            if (e instanceof SelfCommandPendingError) return toolError(e.message);
            throw e;
          }
          return textResult({ target: `@${target.slug}`, status: "queued", note });
        },
      );
    },
  };
}

/** The result note, read from the target's state before the command is queued. */
function noteFor(i: {
  self: boolean;
  name: string;
  slug: string;
  errored: boolean;
  turnOpen: boolean;
  idle: boolean;
}): string {
  if (i.self)
    return i.name === "compact"
      ? "Your /compact runs when this turn ends. Write down where you are before you end the turn."
      : `Your /${i.name} runs when this turn ends.`;
  if (i.errored) return `@${i.slug} is errored; it runs after a human restarts it.`;
  if (i.turnOpen) return `Runs when @${i.slug}'s current turn ends.`;
  if (i.idle) return "Runs now.";
  return `Wakes @${i.slug} to run it.`;
}
