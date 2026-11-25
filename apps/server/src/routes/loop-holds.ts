import { resumeLoopHoldResponseSchema } from "@open-factory/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireUser } from "../auth/require-user.ts";
import type { LoopResume } from "../messaging/loop-resume.ts";

/** Spec §6.6: resuming a held pair is a human's act; an agent token gets 401 like no auth. */
export const loopHoldsRoutes: FastifyPluginAsyncZod<{ resume: LoopResume }> = async (
  app,
  { resume },
) => {
  app.addHook("onRequest", requireUser);
  app.post(
    "/api/loop-holds/:id/resume",
    {
      schema: {
        params: z.object({ id: z.string().min(1) }),
        response: { 200: resumeLoopHoldResponseSchema },
      },
    },
    async (req) => {
      if (!req.user) throw new Error("requireUser did not set request.user");
      return resume.resume(req.params.id, req.user.id);
    },
  );
};
