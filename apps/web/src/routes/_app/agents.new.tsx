import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { sheetRedirect } from "@/features/sheets/redirect";

/** The old form URL: opens New agent over the list, with the template from `?template=` (the sheet shows an unknown
 *  or broken one unchosen). */
export const Route = createFileRoute("/_app/agents/new")({
  validateSearch: z.object({ template: z.string().min(1).optional().catch(undefined) }),
  beforeLoad: ({ preload, search, context }) =>
    sheetRedirect(
      { kind: "new-agent", ...(search.template ? { template: search.template } : {}) },
      "/agents",
      { preload, router: context.router },
    ),
});
