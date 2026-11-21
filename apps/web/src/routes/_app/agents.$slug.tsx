import { ApiError } from "@open-factory/shared";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { z } from "zod";
import { agentDetailQueryOptions, summaryFromAgentsList } from "@/features/session/api";
import { SessionView } from "@/features/session/session-view";

export const Route = createFileRoute("/_app/agents/$slug")({
  // An invalid ?event (abc, 0) is ignored rather than an error page.
  validateSearch: z.object({
    event: z.coerce.number().int().positive().optional().catch(undefined),
    // A message id: the view resolves it to the recipient's event (GET /api/messages/:id).
    message: z.string().min(1).optional().catch(undefined),
  }),
  // When a list already holds the agent's summary the page renders from it at once and the detail
  // loads behind it (spec §11); only an uncached slug waits here, so it can show the not-found state.
  loader: async ({ context, params, preload }) => {
    const qc = context.queryClient;
    const opts = agentDetailQueryOptions(params.slug);
    if (summaryFromAgentsList(qc, params.slug)) {
      // A hover warms the cache once (the detail's staleTime is 0, so a prefetch would refetch on
      // every hover). A real navigation fetches nothing here: the view's useSession reads the detail
      // fresh on mount (for its lastSeq), and a loader prefetch that finished first would be a
      // second GET.
      if (preload) void qc.ensureQueryData(opts).catch(() => {});
      return;
    }
    try {
      await qc.ensureQueryData(opts);
    } catch (e) {
      if (e instanceof ApiError && e.code === "agent_not_found") throw notFound();
      // Anything else: the view shows the error with a retry.
    }
  },
  component: function SessionRoute() {
    const { slug } = Route.useParams();
    const { event, message } = Route.useSearch();
    return (
      <SessionView
        key={`${slug}:${event ?? ""}:${message ?? ""}`}
        slug={slug}
        eventSeq={event}
        messageId={message}
      />
    );
  },
});
