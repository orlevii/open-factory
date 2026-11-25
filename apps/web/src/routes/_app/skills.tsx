import { createFileRoute } from "@tanstack/react-router";
import { hostQueryOptions } from "@/lib/host";
import { libraryQueryOptions, marketplacesQueryOptions } from "@/lib/library";

// The layout of the Skills views: it loads what the header reads on every view (the skills Library and the marketplaces).
export const Route = createFileRoute("/_app/skills")({
  loader: async ({ context, preload }) => {
    const qc = context.queryClient;
    // Path help reads it when an add sheet opens; not awaited, so a failure never blocks the page.
    void qc.prefetchQuery(hostQueryOptions);
    // The header's check summary reads the marketplaces on every view; not awaited, like the host.
    void qc.prefetchQuery(marketplacesQueryOptions);
    await Promise.allSettled([
      preload ? qc.ensureQueryData(libraryQueryOptions) : qc.fetchQuery(libraryQueryOptions),
    ]);
  },
});
