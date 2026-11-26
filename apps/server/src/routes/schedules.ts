import {
  createScheduleBodySchema,
  patchScheduleBodySchema,
  scheduleListSchema,
  scheduleResponseSchema,
} from "@open-factory/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireUser } from "../auth/require-user.ts";
import { ScheduleError } from "../scheduling/errors.ts";
import type { Actor } from "../scheduling/schedule-service.ts";
import { refQuerySchema } from "./ref-params.ts";

const keyParams = z.object({ key: z.string().min(1).max(20) });
const listQuery = z.object({
  target: refQuerySchema.optional(),
  done: z.enum(["true", "false"]).optional(),
});

/**
 * Spec §11: the human schedule API. Human session only (`requireUser` as an `onRequest` hook, so an agent token gets
 * 401 like no auth); every change goes through `ScheduleService`.
 */
export const schedulesRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("onRequest", requireUser);
  const actorOf = (req: { user?: { id: string } }): Actor => {
    if (!req.user) throw new Error("requireUser did not set request.user");
    return { kind: "human", id: req.user.id };
  };
  const one = { params: keyParams, response: { 200: scheduleResponseSchema } };

  app.get(
    "/api/schedules",
    { schema: { querystring: listQuery, response: { 200: scheduleListSchema } } },
    async (req) => {
      const r = await app.schedules.list({
        ...(req.query.target ? { target: req.query.target } : {}),
        done: req.query.done === "true",
      });
      return { schedules: r.items, more: r.more };
    },
  );

  app.get("/api/schedules/:key", { schema: one }, async (req) => {
    const s = await app.schedules.get(req.params.key, { includeDeleted: true });
    if (!s) throw new ScheduleError("schedule_not_found", "There is no such schedule.", 404);
    return { schedule: s };
  });

  app.post(
    "/api/schedules",
    { schema: { body: createScheduleBodySchema, response: { 201: scheduleResponseSchema } } },
    async (req, reply) => {
      const r = await app.schedules.create(actorOf(req), req.body);
      reply.code(201);
      return { schedule: r.item };
    },
  );

  app.patch(
    "/api/schedules/:key",
    {
      schema: {
        params: keyParams,
        body: patchScheduleBodySchema,
        response: { 200: scheduleResponseSchema },
      },
    },
    async (req) => ({ schedule: await app.schedules.edit(actorOf(req), req.params.key, req.body) }),
  );

  app.post("/api/schedules/:key/pause", { schema: one }, async (req) => ({
    schedule: await app.schedules.pause(actorOf(req), req.params.key),
  }));
  app.post("/api/schedules/:key/resume", { schema: one }, async (req) => ({
    schedule: await app.schedules.resume(actorOf(req), req.params.key),
  }));
  app.delete("/api/schedules/:key", { schema: one }, async (req) => ({
    schedule: await app.schedules.remove(actorOf(req), req.params.key),
  }));
  app.post("/api/schedules/:key/restore", { schema: one }, async (req) => ({
    schedule: await app.schedules.restore(actorOf(req), req.params.key),
  }));
};
