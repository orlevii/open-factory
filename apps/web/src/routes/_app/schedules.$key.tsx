import { createFileRoute } from "@tanstack/react-router";
import { sheetRedirect } from "@/features/sheets/redirect";

/** The old page URL: opens the Edit schedule sheet over the list (an unknown key shows the sheet's not-found body). */
export const Route = createFileRoute("/_app/schedules/$key")({
  beforeLoad: ({ params, preload, context }) =>
    sheetRedirect({ kind: "edit-schedule", key: params.key.toUpperCase() }, "/schedules", {
      preload,
      router: context.router,
    }),
});
