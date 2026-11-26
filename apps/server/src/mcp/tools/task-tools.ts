import {
  commentTaskToolSchema,
  createTaskToolSchema,
  getTaskToolSchema,
  listTasksToolSchema,
  type TaskStatus,
  updateTaskToolSchema,
} from "@open-factory/shared";
import { agentTagOf } from "@open-factory/shared/tags";
import type { AgentRecord, Principal } from "../../principals/principal-store.ts";
import { type AgentFacing, UnknownTagsError } from "../../principals/principal-text.ts";
import { TaskError } from "../../tasks/errors.ts";
import type { Actor } from "../../tasks/permission.ts";
import type { TaskService } from "../../tasks/task-service.ts";
import {
  callerOf,
  type McpServer,
  type ToolContext,
  type ToolRegistration,
  textResult,
  toolError,
} from "../server.ts";

/** Spec §9: results are one text block of compact JSON; agent-written text is JSON-escaped data. */
const listNote = (limit: number) =>
  limit >= 200
    ? "Showing the 200 most recently updated; narrow the filter."
    : `Showing the ${limit} most recently updated; pass a larger limit (max 200) or narrow the filter.`;

/** A principal as an agent reads it: `<@ref|handle>`. */
const principal = (p: { ref: string; handle: string }) => agentTagOf(p);

type TaskTools = {
  tasks: TaskService;
  /** The calling agent, from the token (never from an argument). */
  loadAgent(id: string): Promise<AgentRecord | undefined>;
  /** The calling agent's principal: its ref and handle, which the actor carries. */
  loadPrincipal(id: string): Promise<Principal | undefined>;
  /** Tags for the handles a result names and a renderer for the stored text it returns (spec §4.4). */
  facing(want: { handles?: readonly string[]; texts?: readonly string[] }): Promise<AgentFacing>;
};

/**
 * The five task tools, registered for every agent (spec §9). The caller is always the token's agent. A `TaskError` is a
 * tool error with its sentence; `TaskService` is the only place that decides who may do what.
 */
const NOT_REACHED_TEXT = {
  archived: (n: string) => `${n} is archived and can't receive messages.`,
  terminated: (n: string) => `${n} was terminated and can't receive messages.`,
  too_many: (n: string) => `Too many tags in one comment; ${n} was left out.`,
};
/** One sentence per `not_reached` entry, so the tool's entries all have the same shape. */
const notReachedText = (n: { name: string; reason: keyof typeof NOT_REACHED_TEXT }) =>
  NOT_REACHED_TEXT[n.reason](n.name);

/** `warnings` only when there is one. */
const warned = (w: readonly string[] | undefined) =>
  w?.length ? { warnings: [...new Set(w)] } : {};

export function taskTools(d: TaskTools): ToolRegistration[] {
  const actorOf = async (tctx: ToolContext): Promise<Actor> => {
    const id = callerOf(tctx);
    const a = await d.loadAgent(id);
    const p = a && (await d.loadPrincipal(a.id));
    if (!p) throw new TaskError("ended", "You can't work on tasks: you were terminated.", 409);
    return { kind: "agent", id: p.id, ref: p.ref, handle: p.handle };
  };
  const guard = async <T>(fn: () => Promise<T>) => {
    try {
      return textResult(await fn());
    } catch (e) {
      if (e instanceof TaskError || e instanceof UnknownTagsError) return toolError(e.message);
      throw e;
    }
  };
  const view = async (r: {
    task: {
      key: string;
      status: string;
      assignee?: { ref: string; handle: string };
      assigneeEnded?: string;
      blockedBy: string[];
    };
    note?: string;
    warnings?: string[];
  }) => {
    return {
      key: r.task.key,
      status: r.task.status,
      ...(r.task.assignee ? { assignee: agentTagOf(r.task.assignee) } : {}),
      ...(r.task.assigneeEnded ? { assignee_ended: r.task.assigneeEnded } : {}),
      blocked_by: r.task.blockedBy,
    };
  };
  return [
    {
      register(server: McpServer) {
        server.registerTool(
          "create_task",
          {
            description:
              "Create a task when work is worth tracking or handing off; for a quick question or request, just send a message. Assigning it sends it to that agent's session.",
            inputSchema: createTaskToolSchema,
          },
          (
            args: {
              title: string;
              body?: string;
              assignee?: string;
              depends_on?: string[];
              links?: Parameters<TaskService["create"]>[1]["links"];
            },
            tctx: ToolContext,
          ) =>
            guard(async () => {
              const r = await d.tasks.create(await actorOf(tctx), {
                title: args.title,
                ...(args.body !== undefined ? { body: args.body } : {}),
                ...(args.assignee !== undefined ? { assignee: args.assignee } : {}),
                ...(args.depends_on ? { dependsOn: args.depends_on } : {}),
                ...(args.links ? { links: args.links } : {}),
              });
              return {
                ...(await view(r)),
                ...(r.note ? { note: r.note } : {}),
                ...warned(r.warnings),
              };
            }),
        );
        server.registerTool(
          "update_task",
          {
            description:
              "Change a task. depends_on and links replace the whole list; a field you leave out is unchanged; assignee null unassigns.",
            inputSchema: updateTaskToolSchema,
          },
          (
            args: {
              id: string;
              title?: string;
              body?: string;
              status?: TaskStatus;
              assignee?: string | null;
              depends_on?: string[];
              links?: Parameters<TaskService["create"]>[1]["links"];
            },
            tctx: ToolContext,
          ) =>
            guard(async () => {
              const r = await d.tasks.update(await actorOf(tctx), args.id, {
                ...(args.title !== undefined ? { title: args.title } : {}),
                ...(args.body !== undefined ? { body: args.body } : {}),
                ...(args.status ? { status: args.status } : {}),
                ...(args.assignee !== undefined ? { assignee: args.assignee } : {}),
                ...(args.depends_on ? { dependsOn: args.depends_on } : {}),
                ...(args.links ? { links: args.links } : {}),
              });
              return {
                ...(await view(r)),
                changed: r.changed,
                ...(r.note ? { note: r.note } : {}),
                ...warned(r.warnings),
              };
            }),
        );
        server.registerTool(
          "list_tasks",
          {
            description:
              "List tasks, newest updated first. Defaults to open and in-progress tasks; filter by status, assignee, unassigned or created_by.",
            inputSchema: listTasksToolSchema,
          },
          (
            args: {
              status?: TaskStatus[];
              assignee?: string;
              unassigned?: true;
              created_by?: string;
              limit?: number;
            },
            tctx: ToolContext,
          ) =>
            guard(async () => {
              const limit = args.limit ?? 50;
              const warnings: string[] = [];
              const page = await d.tasks.list(
                await actorOf(tctx),
                {
                  status: args.status ?? ["open", "in_progress"],
                  ...(args.assignee ? { assignee: args.assignee } : {}),
                  ...(args.unassigned ? { unassigned: true } : {}),
                  ...(args.created_by ? { createdBy: args.created_by } : {}),
                  limit,
                },
                warnings,
              );
              const facing = await d.facing({ texts: page.items.map((t) => t.title) });
              return {
                tasks: page.items.map((t) => ({
                  key: t.key,
                  title: facing.render(t.title),
                  status: t.status,
                  ...(t.assignee ? { assignee: principal(t.assignee) } : {}),
                  ...(t.assignee?.ended ? { assignee_ended: t.assignee.ended } : {}),
                  blocked_by: t.blockedBy,
                  created_by: principal(t.createdBy),
                  updated_at: t.updatedAt.toISOString(),
                })),
                more: page.nextCursor !== null,
                ...(page.nextCursor !== null ? { note: listNote(limit) } : {}),
                ...warned(warnings),
              };
            }),
        );
        server.registerTool(
          "get_task",
          {
            description:
              "Read one task: its brief, status, dependencies, links and newest 50 comments. comments_before is a comment id for earlier ones.",
            inputSchema: getTaskToolSchema,
          },
          (args: { id: string; comments_before?: string }, tctx: ToolContext) =>
            guard(async () => {
              await actorOf(tctx);
              const t = await d.tasks.detail(args.id, {
                comments: {
                  limit: 50,
                  ...(args.comments_before ? { before: args.comments_before } : {}),
                },
              });
              const first = t.comments[0];
              const facing = await d.facing({
                handles: t.blocks.flatMap((x) => (x.assignee ? [x.assignee] : [])),
                texts: [
                  t.title,
                  t.body,
                  ...t.dependsOn.map((x) => x.title),
                  ...t.blocks.map((x) => x.title),
                  ...t.comments.map((c) => c.body),
                ],
              });
              return {
                key: t.key,
                title: facing.render(t.title),
                body: facing.render(t.body),
                status: t.status,
                ...(t.assignee ? { assignee: principal(t.assignee) } : {}),
                ...(t.assignee?.ended ? { assignee_ended: t.assignee.ended } : {}),
                created_by: principal(t.createdBy),
                created_at: t.createdAt.toISOString(),
                updated_at: t.updatedAt.toISOString(),
                blocked_by: t.blockedBy,
                depends_on: t.dependsOn.map((x) => ({
                  key: x.key,
                  title: facing.render(x.title),
                  status: x.status,
                })),
                blocks: t.blocks.map((x) => ({
                  key: x.key,
                  title: facing.render(x.title),
                  status: x.status,
                  ...(x.assignee ? { assignee: facing.tag(x.assignee) } : {}),
                })),
                links: t.links.map((l) => ({
                  kind: l.kind,
                  ...(l.target ? { target: l.target } : {}),
                  ...(l.agent ? { agent: principal(l.agent) } : {}),
                  ...(l.title ? { title: l.title } : {}),
                  ...(l.agent?.ended ? { ended: l.agent.ended } : {}),
                })),
                comments: t.comments.map((c) => ({
                  id: c.id,
                  author: principal(c.author),
                  body: facing.render(c.body),
                  created_at: c.createdAt.toISOString(),
                })),
                earlier_comments: t.earlierComments,
                ...(t.earlierComments > 0 && first
                  ? {
                      note: `${t.earlierComments} earlier comments; call get_task with comments_before=${first.id} for them.`,
                    }
                  : {}),
              };
            }),
        );
        server.registerTool(
          "comment_task",
          {
            description:
              "Comment on a task. Use it to answer a task or a comment on it: your text output doesn't reach the thread. Tag an agent or a person as <@ref|handle> to bring them in; it also goes to the assignee.",
            inputSchema: commentTaskToolSchema,
          },
          (args: { id: string; body: string }, tctx: ToolContext) =>
            guard(async () => {
              const r = await d.tasks.comment(await actorOf(tctx), args.id, args.body);
              const facing = await d.facing({ handles: r.notReached.map((n) => n.name) });
              return {
                id: r.id,
                delivered_to: r.deliveredTo.map(agentTagOf),
                mentioned_humans: r.mentionedHumans.map(agentTagOf),
                not_reached: r.notReached.map((n) => {
                  const name = facing.tag(n.name);
                  return { ...n, name, detail: notReachedText({ ...n, name }) };
                }),
                held: r.held,
                ...(r.note ? { note: r.note } : {}),
                ...warned(r.warnings),
              };
            }),
        );
      },
    },
  ];
}
