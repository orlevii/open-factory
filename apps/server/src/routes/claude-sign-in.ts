import {
  type AttemptView,
  attemptResponseSchema,
  credentialResponseSchema,
  MSG,
  signInStatusSchema,
  startSignInBodySchema,
  submitCodeBodySchema,
  waitBodySchema,
} from "@open-factory/shared";
import type { FastifyReply } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireUser } from "../auth/require-user.ts";
import type { Outcome } from "../credentials/sign-in/attempts.ts";
import { ApiError } from "../errors.ts";

// Spec §5.5. Mounted under /api/claude-sign-in, never /api/credentials, so no path can shadow a credential
// named `sign-in` (D19). No body is ever logged here: Fastify logs the method and URL only, and none of these
// URLs carries data. Every refusal is the store's fixed ApiError/FieldError, answered by the error handler.

const outcomeSchemas = {
  200: credentialResponseSchema,
  201: credentialResponseSchema,
  202: attemptResponseSchema,
};
const attemptParams = z.object({ attemptId: z.string().min(1).max(64) });

export const claudeSignInRoutes: FastifyPluginAsyncZod = async (app) => {
  // onRequest: auth before validation (401 before 400).
  app.addHook("onRequest", requireUser);
  const userOf = (req: { user?: { id: string } }) => {
    if (!req.user) throw new Error("requireUser did not set request.user");
    return req.user.id;
  };
  /** A credential (the outcome) or the attempt as it stands, still working (202). */
  const answer = (reply: FastifyReply, r: Outcome | AttemptView) =>
    "credential" in r
      ? reply.code(r.status).send({ credential: r.credential })
      : reply.code(202).send({ attempt: r });

  app.get(
    "/api/claude-sign-in",
    { schema: { response: { 200: signInStatusSchema } } },
    async (req) => ({
      available: await app.signInAvailable(),
      attempt: app.signIn.view(userOf(req)),
    }),
  );

  app.post(
    "/api/claude-sign-in",
    { schema: { body: startSignInBodySchema, response: { 200: attemptResponseSchema } } },
    async (req) => {
      const userId = userOf(req);
      if (!(await app.signInAvailable()))
        throw new ApiError(503, "sign_in_unavailable", MSG.signInUnavailable);
      const { replace } = req.body;
      return {
        attempt: await app.signIn.start(userId, replace !== undefined ? { replace } : {}),
      };
    },
  );

  app.post(
    "/api/claude-sign-in/code",
    { schema: { body: submitCodeBodySchema, response: outcomeSchemas } },
    async (req, reply) => {
      const { attemptId, code, name } = req.body;
      return answer(
        reply,
        await app.signIn.submit(userOf(req), attemptId, {
          code,
          ...(name !== undefined ? { name } : {}),
        }),
      );
    },
  );

  app.post(
    "/api/claude-sign-in/code/wait",
    { schema: { body: waitBodySchema, response: outcomeSchemas } },
    async (req, reply) => answer(reply, await app.signIn.wait(userOf(req), req.body.attemptId)),
  );

  app.delete(
    "/api/claude-sign-in/:attemptId",
    { schema: { params: attemptParams } },
    async (req, reply) => {
      await app.signIn.cancel(userOf(req), req.params.attemptId);
      return reply.code(204).send();
    },
  );
};
