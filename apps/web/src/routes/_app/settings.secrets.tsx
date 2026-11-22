import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { secretsQueryOptions } from "@/features/settings/api";
import { SecretsSection } from "@/features/settings/secrets-section";

export const Route = createFileRoute("/_app/settings/secrets")({
  // ?addSecret=NAME opens the add-secret form with the name filled in (the New agent warnings
  // link here).
  validateSearch: z.object({ addSecret: z.string().optional().catch(undefined) }),
  loader: async ({ context, preload }) => {
    const qc = context.queryClient;
    await Promise.allSettled([
      preload ? qc.ensureQueryData(secretsQueryOptions) : qc.fetchQuery(secretsQueryOptions),
    ]);
  },
  component: function SecretsPage() {
    const { addSecret } = Route.useSearch();
    return <SecretsSection addSecret={addSecret} />;
  },
});
