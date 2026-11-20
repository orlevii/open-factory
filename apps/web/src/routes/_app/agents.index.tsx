import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import { PageBody, PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { UndoArchiveLine } from "@/features/agents/agent-actions";
import { AgentTree } from "@/features/agents/agent-tree";
import { agentsListQueryOptions } from "@/features/agents/api";
import { PrerequisiteLine, usePrerequisites } from "@/features/agents/prerequisites";
import { runningQueryOptions } from "@/features/session/api";
import { useAgentStatusFrames } from "@/features/session/use-agent-status";

export const Route = createFileRoute("/_app/agents/")({
  // Unknown values fall back to the default view rather than an error page.
  validateSearch: z.object({
    archived: z.literal("only").optional().catch(undefined),
    justArchived: z.string().min(1).optional().catch(undefined),
  }),
  component: AgentsPage,
});

function AgentsPage() {
  useAgentStatusFrames();
  const { archived, justArchived } = Route.useSearch();
  const filter = archived ?? "exclude";
  const { data: agents, isError } = useQuery(agentsListQueryOptions(filter));
  const navigate = useNavigate();
  // The Undo line is for an agent that is archived right now: a reload or a revisited URL after
  // an Undo must not offer to restore an active agent.
  const archivedList = useQuery({ ...agentsListQueryOptions("only"), enabled: !!justArchived });
  const stillArchived =
    justArchived !== undefined && !!archivedList.data?.some((a) => a.slug === justArchived);
  // Restored from the line on this visit: the line stays to say so after the URL is cleared.
  const [restored, setRestored] = useState<string>();
  const lineSlug = stillArchived ? justArchived : restored;
  return (
    <>
      <PageHeader
        title="Agents"
        meta={
          <>
            {filter === "exclude" && <RunningCount />}
            <ArchivedFilter value={filter} />
          </>
        }
        actions={
          <Button variant="ghost" asChild>
            <Link to="/agents/new" title="New agent">
              <Plus aria-hidden="true" data-icon="inline-start" />
              <span className="max-md:sr-only">New agent</span>
            </Link>
          </Button>
        }
      />
      <PageBody>
        <div className="grid gap-4">
          {lineSlug && (
            // One grid item: the line's two live regions shouldn't each take a gap.
            <div>
              <UndoArchiveLine
                key={lineSlug}
                slug={lineSlug}
                onRestored={() => {
                  setRestored(lineSlug);
                  void navigate({
                    to: "/agents",
                    search: (s) => ({ ...s, justArchived: undefined }),
                    replace: true,
                  });
                }}
              />
            </div>
          )}
          {isError && !agents && (
            <p role="alert" className="text-sm text-muted-foreground">
              Couldn't load agents.
            </p>
          )}
          {agents && agents.length === 0 && filter === "exclude" && <EmptyAgents />}
          {agents && agents.length === 0 && filter === "only" && (
            <p className="text-sm text-muted-foreground">No archived agents.</p>
          )}
          {agents && agents.length > 0 && <AgentTree agents={agents} />}
        </div>
      </PageBody>
    </>
  );
}

function EmptyAgents() {
  const p = usePrerequisites();
  if (p.loading) return null;
  if (p.failed) return <p className="text-sm text-muted-foreground">No agents yet.</p>;
  return (
    <PrerequisiteLine
      missing={p.missing}
      invalidTemplate={p.invalidTemplate}
      prefix="No agents yet."
    />
  );
}

/** "3 of 8 running", live from the `supervisor` frame; hidden on Archived and below md. */
function RunningCount() {
  // Filled by the list fetch on this page and by supervisor frames: no fetch of its own.
  const { data } = useQuery({ ...runningQueryOptions, enabled: false });
  if (!data) return null;
  return (
    <span className="ml-2 text-[0.8125rem] leading-[1.125rem] whitespace-nowrap text-muted-foreground max-md:hidden">
      {data.count} of {data.max} running
    </span>
  );
}

/** Active / Archived as a native radio pair (arrow keys move between them), kept in the URL. */
function ArchivedFilter({ value }: { value: "exclude" | "only" }) {
  const navigate = useNavigate();
  const options = [
    { value: "exclude", label: "Active" },
    { value: "only", label: "Archived" },
  ] as const;
  return (
    <fieldset className="ml-2 flex items-center gap-0.5 rounded-md border border-border p-0.5">
      <legend className="sr-only">Show</legend>
      {options.map((o) => (
        <label
          key={o.value}
          className="flex h-6 cursor-pointer items-center rounded-sm px-2 text-[0.8125rem] text-muted-foreground transition-[background-color,color] duration-150 hover:text-foreground has-checked:bg-sidebar-accent has-checked:text-foreground has-focus-visible:ring-2 has-focus-visible:ring-ring"
        >
          <input
            type="radio"
            name="archived-filter"
            value={o.value}
            checked={value === o.value}
            onChange={() =>
              void navigate({
                to: "/agents",
                search: o.value === "only" ? { archived: "only" } : {},
              })
            }
            className="sr-only"
          />
          {o.label}
        </label>
      ))}
    </fieldset>
  );
}
