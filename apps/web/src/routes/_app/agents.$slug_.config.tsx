import { ApiError } from "@open-factory/shared";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { ResourceNotFound } from "@/components/route-states";
import { agentConfigQueryOptions, hostSkillsQueryOptions } from "@/features/config/api";
import { AgentConfigPage } from "@/features/config/config-page";
import { noAgentLine } from "@/features/config/messages";
import { agentDetailQueryOptions } from "@/features/session/api";
import { secretsQueryOptions } from "@/features/settings/api";
import { templatesQueryOptions } from "@/features/templates/api";

// `$slug_` keeps this page out of the session view's layout: it's a sibling of Usage, not a child.
export const Route = createFileRoute("/_app/agents/$slug_/config")({
  loader: async ({ context, params, preload }) => {
    const qc = context.queryClient;
    // The Raw JSON editor's chunk loads with the data on a real visit; a hover elsewhere doesn't fetch it. A failed
    // load is the editor's to handle (it falls back to the textarea).
    if (!preload) import("@/features/templates/code-editor").catch(() => {});
    try {
      await Promise.all([
        qc.ensureQueryData(agentDetailQueryOptions(params.slug)),
        qc.ensureQueryData(agentConfigQueryOptions(params.slug)),
      ]);
    } catch (e) {
      if (e instanceof ApiError && e.code === "agent_not_found") throw notFound();
      // Anything else: the page shows the error line.
    }
    // The pickers' lists: started now, never waited on.
    void qc.prefetchQuery(hostSkillsQueryOptions);
    void qc.prefetchQuery(secretsQueryOptions);
    void qc.prefetchQuery(templatesQueryOptions);
  },
  notFoundComponent: NotFound,
  component: ConfigRoute,
});

function NotFound() {
  const { slug } = Route.useParams();
  return <ResourceNotFound title={noAgentLine(slug)} backTo="/agents" backLabel="Back to agents" />;
}

function ConfigRoute() {
  const { slug } = Route.useParams();
  return <AgentConfigPage slug={slug} />;
}
