import { ApiError } from "@open-factory/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { PageBody, PageHeader } from "@/components/page-header";
import { ResourceNotFound } from "@/components/route-states";
import { AgentActions } from "@/features/agents/agent-actions";
import { AgentForm } from "@/features/agents/agent-form";
import { updateAgent } from "@/features/agents/api";
import { agentDetailQueryOptions } from "@/features/session/api";

// `$slug_` keeps this page out of the session view's layout: it's a sibling, not a child.
export const Route = createFileRoute("/_app/agents/$slug_/edit")({
  // Only so the first load shows the pending mark and an unknown slug the not-found state.
  loader: async ({ context, params }) => {
    try {
      await context.queryClient.ensureQueryData(agentDetailQueryOptions(params.slug));
    } catch (e) {
      if (e instanceof ApiError && e.code === "agent_not_found") throw notFound();
      // Anything else: the page shows the error line.
    }
  },
  notFoundComponent: () => (
    <ResourceNotFound title="Agent not found." backTo="/agents" backLabel="Back to agents" />
  ),
  component: EditAgent,
});

function EditAgent() {
  const { slug } = Route.useParams();
  const qc = useQueryClient();
  const { data, isError } = useQuery(agentDetailQueryOptions(slug));
  const agent = data?.agent;
  return (
    <>
      <PageHeader title="Edit agent" documentTitle={`Edit @${slug}`} />
      <PageBody>
        {!agent && isError && (
          <p role="alert" className="text-sm text-muted-foreground">
            Couldn't load this agent.
          </p>
        )}
        {agent?.kind === "ephemeral" && (
          // The server refuses every edit to a spawned agent (`409 ephemeral_agent`, decision Q5):
          // say so instead of a form whose save can't succeed.
          <div className="grid gap-2 text-sm">
            <p className="text-muted-foreground">
              Spawned agents can't be edited; terminate it instead.
            </p>
            <p>
              <Link
                to="/agents/$slug"
                params={{ slug }}
                className="underline underline-offset-4 decoration-muted-foreground hover:decoration-ring"
              >
                Open <span className="font-mono">@{slug}</span>'s session
              </Link>
            </p>
          </div>
        )}
        {agent && agent.kind !== "ephemeral" && (
          <div className="grid gap-6">
            {agent.archivedAt && (
              <p className="text-sm text-muted-foreground">This agent is archived.</p>
            )}
            {/* Seeded once: a status frame or refetch must not overwrite what is being typed. */}
            <AgentForm
              key={slug}
              mode="edit"
              initial={agent}
              onSubmit={async (body) => {
                const saved = await updateAgent(slug, body);
                // The response is the saved agent: show it now, and let the lists (and the
                // detail's queue) catch up in the background rather than hold up "Saved.".
                qc.setQueryData(agentDetailQueryOptions(slug).queryKey, (d) =>
                  d ? { ...d, agent: saved } : d,
                );
                void qc.invalidateQueries({ queryKey: ["agents"] });
                void qc.invalidateQueries({ queryKey: ["agent", slug] });
                return saved;
              }}
            />
            <AgentActions agent={agent} />
          </div>
        )}
      </PageBody>
    </>
  );
}
