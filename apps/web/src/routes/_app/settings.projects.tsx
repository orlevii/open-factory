import { createFileRoute } from "@tanstack/react-router";
import { projectsQueryOptions } from "@/features/settings/api";
import { ProjectsSection } from "@/features/settings/projects-section";

export const Route = createFileRoute("/_app/settings/projects")({
  loader: async ({ context, preload }) => {
    const qc = context.queryClient;
    await Promise.allSettled([
      preload ? qc.ensureQueryData(projectsQueryOptions) : qc.fetchQuery(projectsQueryOptions),
    ]);
  },
  component: ProjectsSection,
});
