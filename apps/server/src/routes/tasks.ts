import {
  createTaskBodySchema,
  patchTaskBodySchema,
  type TaskActivity,
  type TaskDetail,
  type TaskStatus,
  taskChangeResponseSchema,
  taskCommentBodySchema,
  taskCommentResponseSchema,
  taskDetailSchema,
  taskListQuerySchema,
  taskPageSchema,
} from "@open-factory/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireUser } from "../auth/require-user.ts";
import type { Actor } from "../tasks/permission.ts";
import type { TaskReads } from "../tasks/task-reads.ts";

const keyParams = z.object({ key: z.string().min(1).max(20) });

type Detail = Awaited<ReturnType<TaskReads["detail"]>>;

/** The human detail view: comments and history interleaved, oldest first. */
function toDetail(d: Detail, usage: TaskDetail["usage"]): TaskDetail {
  const activity: TaskActivity[] = [
    ...d.comments.map((c) => ({
      type: "comment" as const,
      id: c.id,
      author: c.author,
      body: c.body,
      at: c.createdAt.toISOString(),
    })),
    ...(d.events ?? []).map((e) => ({
      type: "event" as const,
      id: e.id,
      actor: e.actor,
      event: e.event,
      ...("from" in e && e.from !== undefined ? { from: e.from } : {}),
      ...("to" in e && e.to !== undefined ? { to: e.to } : {}),
      at: e.at.toISOString(),
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return {
    key: d.key,
    title: d.title,
    status: d.status,
    assignee: d.assignee,
    blockedBy: d.blockedBy,
    createdBy: d.createdBy,
    updatedAt: d.updatedAt.toISOString(),
    body: d.body,
    createdAt: d.createdAt.toISOString(),
    dependsOn: d.dependsOn,
    blocks: d.blocks,
    links: d.links,
    activity,
    usage,
  };
}

/**
 * Spec §12: the human task API. Human session only (`requireUser` as an `onRequest` hook, so an agent token gets 401
 * like no auth); every change goes through `TaskService`, the one place that decides who may do what.
 */
export const tasksRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("onRequest", requireUser);
  const actorOf = (req: { user?: { id: string; handle: string } }): Actor => {
    if (!req.user) throw new Error("requireUser did not set request.user");
    return { kind: "user", userId: req.user.id, handle: req.user.handle };
  };
  const detail = async (key: string) => {
    const d = await app.tasks.detail(key, { comments: "all", events: true });
    return toDetail(d, await app.usage.task(d.id));
  };

  app.get(
    "/api/tasks",
    { schema: { querystring: taskListQuerySchema, response: { 200: taskPageSchema } } },
    async (req) => {
      const q = req.query;
      const status: TaskStatus[] | "all" | undefined = q.status?.includes("all")
        ? "all"
        : (q.status as TaskStatus[] | undefined);
      const page = await app.tasks.list(actorOf(req), {
        ...(status ? { status } : {}),
        ...(q.assignee ? { assignee: q.assignee } : {}),
        ...(q.unassigned === "true" ? { unassigned: true } : {}),
        ...(q.creator ? { createdBy: q.creator } : {}),
        ...(q.keys ? { keys: q.keys } : {}),
        ...(q.q ? { q: q.q } : {}),
        ...(q.before ? { before: q.before } : {}),
        limit: q.limit,
      });
      return {
        tasks: page.items.map((t) => ({ ...t, updatedAt: t.updatedAt.toISOString() })),
        nextCursor: page.nextCursor,
      };
    },
  );

  app.post(
    "/api/tasks",
    { schema: { body: createTaskBodySchema, response: { 201: taskChangeResponseSchema } } },
    async (req, reply) => {
      const r = await app.tasks.create(actorOf(req), req.body);
      reply.code(201);
      return { task: await detail(r.task.key), ...(r.note ? { note: r.note } : {}) };
    },
  );

  app.get(
    "/api/tasks/:key",
    { schema: { params: keyParams, response: { 200: taskDetailSchema } } },
    async (req) => detail(req.params.key),
  );

  app.patch(
    "/api/tasks/:key",
    {
      schema: {
        params: keyParams,
        body: patchTaskBodySchema,
        response: { 200: taskChangeResponseSchema },
      },
    },
    async (req) => {
      const r = await app.tasks.update(actorOf(req), req.params.key, req.body);
      return { task: await detail(r.task.key), ...(r.note ? { note: r.note } : {}) };
    },
  );

  app.post(
    "/api/tasks/:key/comments",
    {
      schema: {
        params: keyParams,
        body: taskCommentBodySchema,
        response: { 201: taskCommentResponseSchema },
      },
    },
    async (req, reply) => {
      const actor = actorOf(req);
      const r = await app.tasks.comment(actor, req.params.key, req.body.body);
      reply.code(201);
      return {
        comment: {
          type: "comment" as const,
          id: r.id,
          author: { kind: "user" as const, handle: (actor as { handle: string }).handle },
          body: req.body.body,
          at: r.createdAt.toISOString(),
        },
        deliveredTo: r.deliveredTo,
        mentionedHumans: r.mentionedHumans,
        notReached: r.notReached,
        ...(r.note ? { note: r.note } : {}),
      };
    },
  );
};
