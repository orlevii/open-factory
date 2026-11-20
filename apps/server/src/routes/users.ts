import type { Db } from "@open-factory/db";
import {
  createInviteResponseSchema,
  inviteItemSchema,
  signUpStateSchema,
  usersAdminListSchema,
} from "@open-factory/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireUser } from "../auth/require-user.ts";
import { signUpState } from "../users/sign-up-gate.ts";

const idParams = z.object({ id: z.string() });

/** S10 spec §9.2, §9.4: users and invites. Human session only. */
export const usersRoutes: FastifyPluginAsyncZod = async (app) => {
  // onRequest, not preHandler: auth must come before validation (401 before 400).
  app.addHook("onRequest", requireUser);

  app.get("/api/users", { schema: { response: { 200: usersAdminListSchema } } }, async () => ({
    users: await app.userAdmin.list(),
  }));

  app.post(
    "/api/users/:id/disable",
    {
      schema: {
        params: idParams,
        response: { 200: z.object({ revokedInvites: z.number().int() }) },
      },
    },
    async (req) => app.userAdmin.disable((req.user as { id: string }).id, req.params.id),
  );

  app.post("/api/users/:id/enable", { schema: { params: idParams } }, async (req, reply) => {
    await app.userAdmin.enable(req.params.id);
    return reply.code(204).send();
  });

  app.post(
    "/api/invites",
    { schema: { response: { 201: createInviteResponseSchema } } },
    async (req, reply) => {
      const out = await app.invites.create((req.user as { id: string }).id);
      return reply.code(201).send(out);
    },
  );

  app.get(
    "/api/invites",
    { schema: { response: { 200: z.object({ invites: z.array(inviteItemSchema) }) } } },
    async () => ({ invites: await app.invites.listPending() }),
  );

  app.post("/api/invites/:id/revoke", { schema: { params: idParams } }, async (req, reply) => {
    await app.invites.revoke(req.params.id);
    return reply.code(204).send();
  });

  app.post("/api/invites/:id/restore", { schema: { params: idParams } }, async (req, reply) => {
    await app.invites.restore(req.params.id);
    return reply.code(204).send();
  });
};

/** S10 §9.3: what the sign-up page shows. Public (no session yet), so it lives outside the guarded plugin. */
export const signUpStateRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.get(
    "/api/auth/sign-up-state",
    {
      schema: {
        querystring: z.object({ invite: z.string().optional() }),
        response: { 200: signUpStateSchema },
      },
    },
    async (req) => signUpState({ db, invites: app.invites }, req.query.invite),
  );
};
