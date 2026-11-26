import type { AgentRow } from "@open-factory/db";
import { neutraliseEnvelopeTags } from "@open-factory/harness";
import {
  classifyInput,
  hasLineBreak,
  MAX_BODY_BYTES,
  MAX_FOCUS_CHARS,
  sendCommandToolSchema,
  typedCommandName,
} from "@open-factory/shared";
import { unknownRefError } from "@open-factory/shared/tags";
import { knownCommandNames } from "../../agents/commands.ts";
import type { ConfigResolver } from "../../agents/config-resolver.ts";
import {
  AgentArchivedError,
  AgentStartError,
  AgentTerminatedError,
  CommandsUnsupportedError,
  SelfCommandPendingError,
} from "../../agents/errors.ts";
import type { EventStore } from "../../agents/event-store.ts";
import type { AgentRuntimes } from "../../agents/runtimes.ts";
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
  runtimes: AgentRuntimes;
  store: Pick<EventStore, "agentByArg" | "agentCommands">;
  /** The skill list: the running process's (`started`), else the resolver's (I2 §6.2). */
  resolver: Pick<ConfigResolver, "skillsOf">;
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
          let label = `@${wanted || args.target.trim()}`;
          let warning: string | undefined;
          let target: AgentRow | undefined;
          const asSelf = wanted === "me";
          if (asSelf) target = d.caller;
          else {
            const found = await d.store.agentByArg(args.target);
            if (found.kind === "unknown_ref") return toolError(unknownRefError(found.ref));
            if (found.kind === "agent") {
              label = `@${found.handle}`;
              warning = found.warning;
              if (found.row.id === d.caller.id) target = d.caller;
              else if (d.spawned)
                return toolError(`${label} isn't you; you can only send a command to yourself.`);
              else if (found.row.reportsTo === d.caller.id) {
                if (found.row.archivedAt)
                  return toolError(`${label} is archived and can't receive messages.`);
                if (found.row.terminatedAt)
                  return toolError(`${label} was terminated and can't receive messages.`);
                target = found.row;
              }
            } else {
              label = `@${found.name}`;
              if (d.spawned)
                return toolError(`${label} isn't you; you can only send a command to yourself.`);
            }
          }
          const self = target?.id === d.caller.id;
          if (!target) return toolError(`${label} isn't you or one of your direct reports.`);

          const known = knownCommandNames(
            (await d.store.agentCommands(target.id))?.commands,
            await d.resolver.skillsOf(target, d.runtimes.startedOf(target.id)),
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
            name: cls.kind === "command" ? cls.name : typedCommandName(command),
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
            if (e instanceof SelfCommandPendingError || e instanceof CommandsUnsupportedError)
              return toolError(e.message);
            if (e instanceof AgentTerminatedError)
              return toolError(`${label} was terminated and can't receive messages.`);
            if (e instanceof AgentArchivedError)
              return toolError(`${label} is archived and can't receive messages.`);
            if (e instanceof AgentStartError) return toolError(`${label} couldn't be started.`);
            throw e;
          }
          return textResult({
            target: `@${target.slug}`,
            status: "queued",
            note,
            ...(warning ? { warnings: [warning] } : {}),
          });
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
  if (i.errored)
    return `@${i.slug} is errored; it runs after it is restarted (restart_agent, or a human).`;
  if (i.turnOpen) return `Runs when @${i.slug}'s current turn ends.`;
  if (i.idle) return "Runs now.";
  return `Wakes @${i.slug} to run it.`;
}
