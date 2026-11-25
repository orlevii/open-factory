import { createFileRoute } from "@tanstack/react-router";
import { hostQueryOptions } from "@/lib/host";
import { libraryQueryOptions } from "@/lib/library";

// The layout of the Skills page: it loads what the header reads (the skills Library).
export const Route = createFileRoute("/_app/skills")({
  loader: async ({ context, preload }) => {
    const qc = context.queryClient;
    // Path help reads it when an add sheet opens; not awaited, so a failure never blocks the page.
    void qc.prefetchQuery(hostQueryOptions);
    await Promise.allSettled([
      preload ? qc.ensureQueryData(libraryQueryOptions) : qc.fetchQuery(libraryQueryOptions),
    ]);
  },
});
