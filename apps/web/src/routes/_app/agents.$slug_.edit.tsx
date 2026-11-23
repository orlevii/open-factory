import { createFileRoute } from "@tanstack/react-router";
import { sheetRedirect } from "@/features/sheets/redirect";

/** The old form URL: opens Edit agent over the agent's session (an unknown slug, or a human's handle, shows the sheet's
 *  not-found body). `$slug_` keeps it out of the session view's layout. */
export const Route = createFileRoute("/_app/agents/$slug_/edit")({
  beforeLoad: ({ params, preload, context }) =>
    sheetRedirect({ kind: "edit-agent", slug: params.slug }, `/agents/${params.slug}/chat`, {
      preload,
      router: context.router,
    }),
});
