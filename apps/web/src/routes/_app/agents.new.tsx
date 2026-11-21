import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { PageBody, PageHeader } from "@/components/page-header";
import { AgentForm } from "@/features/agents/agent-form";
import { createAgent } from "@/features/agents/api";
import { PrerequisiteLine, usePrerequisites } from "@/features/agents/prerequisites";

export const Route = createFileRoute("/_app/agents/new")({
  // ?template=<name> preselects it (the template page's Create agent links here).
  validateSearch: z.object({ template: z.string().min(1).optional().catch(undefined) }),
  component: NewAgent,
});

function NewAgent() {
  const { template } = Route.useSearch();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const p = usePrerequisites();
  return (
    <>
      <PageHeader title="New agent" />
      <PageBody>
        {p.failed && (
          <p role="alert" className="text-sm text-muted-foreground">
            Couldn't load templates and credentials.
          </p>
        )}
        {/* Nobody fills in five fields to find out the sixth can't be satisfied. */}
        {!p.loading && !p.failed && p.missing && (
          <PrerequisiteLine missing={p.missing} invalidTemplate={p.invalidTemplate} />
        )}
        {!p.loading && !p.failed && !p.missing && (
          <AgentForm
            mode="create"
            initial={{ template }}
            onSubmit={async (body) => {
              const agent = await createAgent(body);
              // The lists refetch in the background; the session view needn't wait for them.
              void qc.invalidateQueries({ queryKey: ["agents"] });
              await navigate({ to: "/agents/$slug", params: { slug: agent.slug } });
            }}
          />
        )}
      </PageBody>
    </>
  );
}
