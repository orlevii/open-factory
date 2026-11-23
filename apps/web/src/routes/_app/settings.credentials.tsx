import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { credentialsQueryOptions } from "@/features/settings/api";
import { CredentialsSection } from "@/features/settings/credentials-section";
import { signInQueryOptions } from "@/features/settings/sign-in/api";

export const Route = createFileRoute("/_app/settings/credentials")({
  validateSearch: z.object({ credential: z.string().min(1).optional().catch(undefined) }),
  // Stale at once (no WebSocket event covers it): fetch on every entry, and the section skips its
  // own mount fetch. A hover warms the cache once. A failure shows in the section, not here.
  loader: async ({ context, preload }) => {
    const qc = context.queryClient;
    // Started with the credentials request, not awaited: a slow sign-in GET never delays the page.
    void qc.prefetchQuery(signInQueryOptions);
    await Promise.allSettled([
      preload
        ? qc.ensureQueryData(credentialsQueryOptions)
        : qc.fetchQuery(credentialsQueryOptions),
    ]);
  },
  component: CredentialsSection,
});
