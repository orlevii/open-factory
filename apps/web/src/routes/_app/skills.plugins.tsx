import { createFileRoute } from "@tanstack/react-router";
import { PeekPage } from "@/features/skills/peek-page";
import { PluginList } from "@/features/skills/plugin-list";
import { PLUGINS_ARRIVAL } from "@/features/skills/use-library-arrival";
import { pluginsQueryOptions } from "@/lib/library";

export const Route = createFileRoute("/_app/skills/plugins")({
  loader: async ({ context, preload }) => {
    const qc = context.queryClient;
    await Promise.allSettled([
      preload ? qc.ensureQueryData(pluginsQueryOptions) : qc.fetchQuery(pluginsQueryOptions),
    ]);
  },
  component: PluginsPage,
});

function PluginsPage() {
  // The Plugins view has no add action: plugins come from marketplaces and are picked in a template's Configuration.
  return (
    <PeekPage view="plugins" arrivalView={PLUGINS_ARRIVAL} list={(p) => <PluginList {...p} />} />
  );
}
