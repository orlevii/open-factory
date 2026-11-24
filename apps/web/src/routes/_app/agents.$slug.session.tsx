import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { SessionView } from "@/features/session/session-view";

export const Route = createFileRoute("/_app/agents/$slug/session")({
  // An invalid ?event (abc, 0) is ignored rather than an error page.
  validateSearch: z.object({
    event: z.coerce.number().int().positive().optional().catch(undefined),
    // A message id: the view resolves it to the recipient's event (GET /api/messages/:id).
    message: z.string().min(1).optional().catch(undefined),
  }),
  component: function SessionRoute() {
    const { slug } = Route.useParams();
    const { event, message } = Route.useSearch();
    // The key remounts the view for each agent, event and message, never the layout.
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
