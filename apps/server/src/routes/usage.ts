import {
  agentsUsageSchema,
  credentialsUsageSchema,
  dailyUsageSchema,
  type UsageDays,
  usageDaysSchema,
} from "@open-factory/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { requireUser } from "../auth/require-user.ts";
import { ApiError } from "../errors.ts";
import type { UsageWindow } from "../usage/usage-service.ts";

/** `?days=` is 7, 30 or 90 (default 30); anything else is `400 invalid_days`. Parsed here, not by a route schema. */
export function parseDays(query: unknown): UsageDays {
  const raw = (query as { days?: unknown } | undefined)?.days;
  if (raw === undefined) return 30;
  const r = usageDaysSchema.safeParse(raw);
  if (!r.success) throw new ApiError(400, "invalid_days", "days must be 7, 30 or 90.");
  return r.data;
}

/**
 * `?window=` on `/api/usage/agents`: absent is the calendar window of `days`; `rolling` is the tree's rolling 7 days
 * (`days` omitted or 7). Any other value, or `rolling` with another `days`, is `400 invalid_window`.
 */
export function parseWindow(query: unknown): UsageWindow {
  const q = query as { window?: unknown; days?: unknown } | undefined;
  if (q?.window === undefined) return { kind: "calendar", days: parseDays(query) };
  if (q.window !== "rolling") {
    throw new ApiError(400, "invalid_window", "window must be rolling or left out.");
  }
  if (q.days !== undefined && parseDays(query) !== 7) {
    throw new ApiError(400, "invalid_window", "window=rolling covers 7 days only.");
  }
  return { kind: "rolling", days: 7 };
}

/** S10 spec §7: rollups over `turns`, human session only. */
export const usageRoutes: FastifyPluginAsyncZod = async (app) => {
  // onRequest, not preHandler: auth must come before validation (401 before 400).
  app.addHook("onRequest", requireUser);

  app.get("/api/usage/daily", { schema: { response: { 200: dailyUsageSchema } } }, async (req) =>
    app.usage.daily(parseDays(req.query)),
  );

  // `window=rolling` is the tree's rolling 7 days; the default is the calendar window.
  app.get("/api/usage/agents", { schema: { response: { 200: agentsUsageSchema } } }, async (req) =>
    app.usage.agents(parseWindow(req.query)),
  );

  app.get(
    "/api/usage/credentials",
    { schema: { response: { 200: credentialsUsageSchema } } },
    async (req) => app.usage.credentials(parseDays(req.query)),
  );
};
