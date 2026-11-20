import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { z } from "zod";
import { PageBody, PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { UndoArchiveLine } from "@/features/agents/agent-actions";
import { AgentTree } from "@/features/agents/agent-tree";
import { agentsListQueryOptions } from "@/features/agents/api";
import { PrerequisiteLine, usePrerequisites } from "@/features/agents/prerequisites";
import { endedMoreQueryOptions, runningQueryOptions } from "@/features/session/api";
import { useAgentStatusFrames } from "@/features/session/use-agent-status";
import { agentsUsageQuery } from "@/features/usage/api";

export const Route = createFileRoute("/_app/agents/")({
  // Unknown values fall back to the default view rather than an error page.
  validateSearch: z.object({
    ended: z.literal("only").optional().catch(undefined),
    /** S4's bookmark: redirected to `ended=only` (S7 UI design §3). */
    archived: z.literal("only").optional().catch(undefined),
    justArchived: z.string().min(1).optional().catch(undefined),
  }),
  beforeLoad: ({ search }) => {
    if (search.archived)
      throw redirect({
        to: "/agents",
        search: { ended: "only", justArchived: search.justArchived },
        replace: true,
      });
  },
  component: AgentsPage,
});

function AgentsPage() {
  useAgentStatusFrames();
  const { ended, justArchived } = Route.useSearch();
  const filter = ended ?? "exclude";
  const { data: agents, isError } = useQuery(agentsListQueryOptions(filter));
  // The tree's 7-day cost column; a failure just leaves the cells empty.
  const usageData = useQuery(agentsUsageQuery("rolling7")).data;
  const usage = useMemo(
    () => (usageData ? new Map(usageData.agents.map((r) => [r.slug, r])) : undefined),
    [usageData],
  );
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
            <EndedFilter value={filter} />
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
            <p className="text-sm text-muted-foreground">No ended agents.</p>
          )}
          {agents && agents.length > 0 && (
            // The Ended view is flat, newest end first (S7 UI design §3): one grid item with its
            // "more" line, so the line sits right under the list. min-w-0: a grid item otherwise grows
            // to its content, and a long ended note pushes the page wider than a phone instead of truncating.
            <div className="min-w-0">
              {/* Shown wherever the tree's cost cells are (§6: where cost first appears), so not below md. */}
              <p className="mb-2 hidden text-[0.8125rem] leading-[1.125rem] text-muted-foreground md:block">
                Costs are estimates for the last 7 days. A persistent agent's figure includes the
                agents it spawned.
              </p>
              <AgentTree agents={agents} flat={filter === "only"} usage={usage} />
              {filter === "only" && <EndedMoreLine />}
            </div>
          )}
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

/** Under the Ended list when older ended agents exist beyond the newest 200 (S7 UI design §3). */
function EndedMoreLine() {
  // Filled by the ended list's fetch: no fetch of its own.
  const { data: more } = useQuery(endedMoreQueryOptions);
  if (!more) return null;
  return (
    <p className="mt-2 text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
      Showing the latest 200 ended agents.
    </p>
  );
}

/** "3 of 8 running", live from the `supervisor` frame; hidden on Ended and below md. */
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

/** Active / Ended as a native radio pair (arrow keys move between them), kept in the URL. */
function EndedFilter({ value }: { value: "exclude" | "only" }) {
  const navigate = useNavigate();
  const options = [
    { value: "exclude", label: "Active" },
    { value: "only", label: "Ended" },
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
            name="ended-filter"
            value={o.value}
            checked={value === o.value}
            onChange={() =>
              void navigate({
                to: "/agents",
                search: o.value === "only" ? { ended: "only" } : {},
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
