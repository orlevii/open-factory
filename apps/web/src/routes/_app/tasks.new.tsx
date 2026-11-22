import { createFileRoute } from "@tanstack/react-router";
import { sheetRedirect } from "@/features/sheets/redirect";

/** The old form URL: opens New task over the list. */
export const Route = createFileRoute("/_app/tasks/new")({
  beforeLoad: ({ preload, context }) =>
    sheetRedirect({ kind: "new-task" }, "/tasks", { preload, router: context.router }),
});
