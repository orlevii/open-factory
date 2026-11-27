import {
  cancelScheduleToolSchema,
  formatOffsetIso,
  listSchedulesToolSchema,
  scheduleMessageToolSchema,
} from "@open-factory/shared";
import type { AgentRecord } from "../../principals/principal-store.ts";
import { type AgentFacing, UnknownMentionsError } from "../../principals/principal-text.ts";
import { ScheduleError } from "../../scheduling/errors.ts";
import type { ScheduleService } from "../../scheduling/schedule-service.ts";
import {
  callerOf,
  type McpServer,
  type ToolContext,
  type ToolRegistration,
  textResult,
  toolError,
} from "../server.ts";

type ScheduleTools = {
  schedules: ScheduleService;
  /** The zone an agent's schedule gets when it passes none (`FACTORY_TIMEZONE`, spec §7.1). */
  factoryZone: string;
  /** The calling agent, from the token (never from an argument). */
  loadAgent(id: string): Promise<AgentRecord | undefined>;
  /** Mentions for the handles a result names and a renderer for the stored text it returns (spec §4.4). */
  facing(want: { handles?: readonly string[]; texts?: readonly string[] }): Promise<AgentFacing>;
};

/**
 * The three schedule tools (spec §9), registered for PERSISTENT agents only (Q12). The caller is always the token's
 * agent; `created_by`, the body author and the envelope's `by` come from it, never from an argument.
 */
export function scheduleTools(d: ScheduleTools): ToolRegistration[] {
  const agentOf = async (tctx: ToolContext) => {
    const a = await d.loadAgent(callerOf(tctx));
    if (!a || a.terminatedAt)
      throw new ScheduleError("ended", "You can't schedule messages: you were terminated.", 409);
    return a;
  };
  const guard = async <T>(fn: () => Promise<T>) => {
    try {
      return textResult(await fn());
    } catch (e) {
      if (e instanceof ScheduleError || e instanceof UnknownMentionsError)
        return toolError(e.message);
      throw e;
    }
  };
  return [
    {
      register(server: McpServer) {
        server.registerTool(
          "schedule_message",
          {
            description:
              "Schedule a message that survives restarts and wakes its target at each run: a 5-field cron (minute hour day-of-month month day-of-week) or a one-shot at time. For a short loop inside this session, use CronCreate instead.",
            inputSchema: scheduleMessageToolSchema,
          },
          (
            args: {
              body: string;
              cron?: string;
              at?: string;
              timezone?: string;
              to?: string;
            },
            tctx: ToolContext,
          ) =>
            guard(async () => {
              const me = await agentOf(tctx);
              const timezone = args.timezone ?? d.factoryZone;
              const r = await d.schedules.create(
                { kind: "agent", id: me.id },
                {
                  ...(args.to !== undefined ? { target: args.to } : {}),
                  ...(args.cron !== undefined ? { cron: args.cron } : {}),
                  ...(args.at !== undefined ? { at: args.at } : {}),
                  timezone,
                  body: args.body,
                },
              );
              const i = r.item;
              const facing = await d.facing({ handles: [i.target.handle] });
              return {
                id: i.key,
                to: facing.mention(i.target.handle),
                ...(i.cron ? { cron: i.cron } : {}),
                ...(i.at ? { at: formatOffsetIso(new Date(i.at), i.timezone) } : {}),
                timezone: i.timezone,
                next_run: i.nextRunAt ? formatOffsetIso(new Date(i.nextRunAt), i.timezone) : null,
                ...(r.note ? { note: r.note } : {}),
                ...(r.warnings?.length ? { warnings: r.warnings } : {}),
              };
            }),
        );
        server.registerTool(
          "list_schedules",
          {
            description: "List your schedules and the ones that target you.",
            inputSchema: listSchedulesToolSchema,
          },
          (_args: Record<string, never>, tctx: ToolContext) =>
            guard(async () => {
              const views = await d.schedules.listForAgent((await agentOf(tctx)).id);
              const facing = await d.facing({
                handles: views.flatMap((v) => [v.to, v.created_by, v.by]),
                texts: views.map((v) => v.body),
              });
              return views.map((v) => ({
                ...v,
                to: facing.mention(v.to),
                created_by: facing.mention(v.created_by),
                by: facing.mention(v.by),
                body: facing.render(v.body),
              }));
            }),
        );
        server.registerTool(
          "cancel_schedule",
          {
            description: "Cancel a schedule you created.",
            inputSchema: cancelScheduleToolSchema,
          },
          (args: { id: string }, tctx: ToolContext) =>
            guard(async () => d.schedules.cancelForAgent((await agentOf(tctx)).id, args.id)),
        );
      },
    },
  ];
}
