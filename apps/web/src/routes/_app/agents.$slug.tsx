import { ApiError } from "@open-factory/shared";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { z } from "zod";
import { agentDetailQueryOptions } from "@/features/session/api";
import { SessionView } from "@/features/session/session-view";

export const Route = createFileRoute("/_app/agents/$slug")({
  validateSearch: z.object({ event: z.coerce.number().int().positive().optional() }),
  // Only so the first load shows the route's pending mark and an unknown slug the not-found state;
  // the view itself fetches the detail fresh for its lastSeq.
  loader: async ({ context, params }) => {
    try {
      await context.queryClient.ensureQueryData(agentDetailQueryOptions(params.slug));
    } catch (e) {
      if (e instanceof ApiError && e.code === "agent_not_found") throw notFound();
      // Anything else: the view shows the error with a retry.
    }
  },
  component: function SessionRoute() {
    const { slug } = Route.useParams();
    const { event } = Route.useSearch();
    return <SessionView key={`${slug}:${event ?? ""}`} slug={slug} eventSeq={event} />;
  },
});
