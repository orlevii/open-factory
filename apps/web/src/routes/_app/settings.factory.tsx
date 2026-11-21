import { createFileRoute } from "@tanstack/react-router";
import { factorySettingsQueryOptions } from "@/features/settings/api";
import { FactorySection } from "@/features/settings/factory-section";

export const Route = createFileRoute("/_app/settings/factory")({
  loader: async ({ context }) => {
    await Promise.allSettled([context.queryClient.ensureQueryData(factorySettingsQueryOptions)]);
  },
  component: FactorySection,
});
