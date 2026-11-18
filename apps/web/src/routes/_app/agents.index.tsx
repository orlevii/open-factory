import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { PageBody, PageHeader } from "@/components/page-header";
import { agentsQueryOptions } from "@/features/session/api";
import { StatusBadge } from "@/features/session/status-badge";
import { UnsandboxedBadge } from "@/features/session/unsandboxed-badge";
import { useAgentStatusFrames } from "@/features/session/use-agent-status";

export const Route = createFileRoute("/_app/agents/")({ component: AgentsList });

function AgentsList() {
  useAgentStatusFrames();
  const { data: agents } = useQuery(agentsQueryOptions);
  return (
    <>
      <PageHeader title="Agents" />
      <PageBody>
        {agents && agents.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No agents yet. Run <code className="font-mono">pnpm seed:dev-agent</code> to create the
            dev agent.
          </p>
        )}
        {agents && agents.length > 0 && (
          <ul className="divide-y divide-border border-y border-border">
            {agents.map((a) => (
              <li key={a.slug}>
                <Link
                  to="/agents/$slug"
                  params={{ slug: a.slug }}
                  className="flex h-11 items-center gap-4 px-2 text-sm hover:bg-sidebar-accent focus-visible:outline-2"
                >
                  <span className="w-28 shrink-0">
                    <StatusBadge status={a.status} />
                  </span>
                  <span className="min-w-0 truncate">{a.displayName}</span>
                  <span className="font-mono text-[0.8125rem] text-muted-foreground">{a.slug}</span>
                  {a.runtime === "local" && (
                    <span className="ml-auto">
                      <UnsandboxedBadge />
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </PageBody>
    </>
  );
}
