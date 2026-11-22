import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { sheetRedirect } from "@/features/sheets/redirect";

/** The old form URL: opens New schedule over the list, with the target from `?target=`. */
export const Route = createFileRoute("/_app/schedules/new")({
  validateSearch: z.object({ target: z.string().min(1).max(64).optional().catch(undefined) }),
  beforeLoad: ({ preload, context, search }) =>
    sheetRedirect(
      { kind: "new-schedule", ...(search.target ? { target: search.target } : {}) },
      "/schedules",
      { preload, router: context.router },
    ),
});
