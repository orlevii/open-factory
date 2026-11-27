import { ApiError } from "@open-factory/shared";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { ResourceNotFound } from "@/components/route-states";
import { agentRefParams } from "@/features/agents/ref-params";
import { agentConfigQueryOptions, templateConfigQueryOptions } from "@/features/config/api";
import { AgentConfigPage } from "@/features/config/config-page";
import { NO_AGENT_LINE } from "@/features/config/messages";
import { agentDetailQueryOptions } from "@/features/session/api";
import { secretsQueryOptions } from "@/features/settings/api";
import { templatesQueryOptions } from "@/features/templates/api";
import { libraryQueryOptions } from "@/lib/library";

// `$ref_` keeps this page out of the session view's layout: it's a sibling of Usage, not a child.
export const Route = createFileRoute("/_app/agents/$ref_/config")({
  params: agentRefParams,
  loader: async ({ context, params, preload }) => {
    const qc = context.queryClient;
    // The Raw JSON editor's chunk loads with the data on a real visit; a hover elsewhere doesn't fetch it. A failed
    // load is the editor's to handle (it falls back to the textarea).
    if (!preload) import("@/features/templates/code-editor").catch(() => {});
    try {
      const [detail] = await Promise.all([
        qc.ensureQueryData(agentDetailQueryOptions(params.ref)),
        qc.ensureQueryData(agentConfigQueryOptions(params.ref)),
      ]);
      // The read-only "Template skill" rows: started with the lists below, not first on mount.
      void qc.prefetchQuery(templateConfigQueryOptions(detail.agent.template));
    } catch (e) {
      if (e instanceof ApiError && e.code === "agent_not_found") throw notFound();
      // Anything else: the page shows the error line.
    }
    // The pickers' lists: started now, never waited on.
    void qc.prefetchQuery(libraryQueryOptions);
    void qc.prefetchQuery(secretsQueryOptions);
    void qc.prefetchQuery(templatesQueryOptions);
  },
  notFoundComponent: NotFound,
  component: ConfigRoute,
});

function NotFound() {
  return <ResourceNotFound title={NO_AGENT_LINE} backTo="/agents" backLabel="Back to agents" />;
}

function ConfigRoute() {
  const { ref: agentRef } = Route.useParams();
  return <AgentConfigPage agentRef={agentRef} />;
}
