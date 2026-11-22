import { createFileRoute } from "@tanstack/react-router";
import { sheetRedirect } from "@/features/sheets/redirect";

/** The old form URL: opens New template over the list; its success opens the editor. */
export const Route = createFileRoute("/_app/templates/new")({
  beforeLoad: ({ preload, context }) =>
    sheetRedirect(
      // biome-ignore lint/suspicious/noThenProperty: SheetSpec's field, not a thenable
      { kind: "new-template", then: "open-editor" },
      "/templates",
      { preload, router: context.router },
    ),
});
