import { createFileRoute } from "@tanstack/react-router";
import { credentialsQueryOptions } from "@/features/settings/api";
import { CredentialsSection } from "@/features/settings/credentials-section";

export const Route = createFileRoute("/_app/settings/credentials")({
  // Stale at once (no WebSocket event covers it): fetch on every entry, and the section skips its
  // own mount fetch. A hover warms the cache once. A failure shows in the section, not here.
  loader: async ({ context, preload }) => {
    const qc = context.queryClient;
    await Promise.allSettled([
      preload
        ? qc.ensureQueryData(credentialsQueryOptions)
        : qc.fetchQuery(credentialsQueryOptions),
    ]);
  },
  component: CredentialsSection,
});
