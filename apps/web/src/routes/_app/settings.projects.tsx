import { createFileRoute } from "@tanstack/react-router";
import { projectsQueryOptions } from "@/features/settings/api";
import { ProjectsSection } from "@/features/settings/projects-section";
import { hostQueryOptions } from "@/lib/host";

export const Route = createFileRoute("/_app/settings/projects")({
  loader: async ({ context, preload }) => {
    const qc = context.queryClient;
    // Path help reads it when the add form opens; not awaited, so a failure never blocks the page.
    void qc.prefetchQuery(hostQueryOptions);
    await Promise.allSettled([
      preload ? qc.ensureQueryData(projectsQueryOptions) : qc.fetchQuery(projectsQueryOptions),
    ]);
  },
  component: ProjectsSection,
});
