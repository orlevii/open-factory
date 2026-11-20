import { ApiError, type UsageDays, usageDaysSchema } from "@open-factory/shared";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, notFound, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { ErrorLine } from "@/components/error-line";
import { PageBody, PageHeader } from "@/components/page-header";
import { ResourceNotFound } from "@/components/route-states";
import { Skeleton } from "@/components/ui/skeleton";
import { agentUsageQuery } from "@/features/usage/api";
import { EstimateLine } from "@/features/usage/estimate-line";
import { RangeFilter } from "@/features/usage/range-filter";
import { UsageChart } from "@/features/usage/usage-chart";
import { ByModelTable, ByTaskTable, SpawnedTable } from "@/features/usage/usage-tables";
import { UsageTotals } from "@/features/usage/usage-totals";

const DEFAULT_DAYS: UsageDays = 30;
const searchSchema = z.object({
  // An unknown range falls back to the default rather than an error page.
  days: usageDaysSchema.optional().catch(undefined),
});

// `$slug_` keeps this page out of the session view's layout: it's a sibling, not a child.
export const Route = createFileRoute("/_app/agents/$slug_/usage")({
  validateSearch: searchSchema,
  // Only so the first load shows the pending mark and an unknown slug the not-found state. No
  // loaderDeps: a range switch must not block the navigation (the page keeps the previous data).
  loader: async ({ context, params, location }) => {
    const days = searchSchema.parse(location.search).days ?? DEFAULT_DAYS;
    try {
      await context.queryClient.ensureQueryData(agentUsageQuery(params.slug, days));
    } catch (e) {
      if (e instanceof ApiError && e.code === "agent_not_found") throw notFound();
      // Anything else: the page shows the error line.
    }
  },
  notFoundComponent: () => (
    <ResourceNotFound title="Agent not found." backTo="/agents" backLabel="Back to agents" />
  ),
  component: AgentUsagePage,
});

function AgentUsagePage() {
  const { slug } = Route.useParams();
  const days = Route.useSearch().days ?? DEFAULT_DAYS;
  const navigate = useNavigate();
  const q = useQuery({
    ...agentUsageQuery(slug, days),
    // Another range of the same agent stays on screen while the new one loads; another agent's never.
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[2] === slug ? prev : undefined),
  });
  const data = q.data;
  const name = data?.agent.displayName ?? `@${slug}`;
  // The range the data on screen covers: the previous one while a switch loads.
  const shownDays = (data?.daily.length ?? days) as UsageDays;
  return (
    <>
      <PageHeader title="Usage" documentTitle={`Usage · ${name}`} />
      <PageBody>
        <div className="grid gap-6">
          <div className="grid gap-3">
            <Link
              to="/agents/$slug"
              params={{ slug }}
              search={{}}
              className="w-fit text-[0.8125rem] leading-[1.125rem] text-muted-foreground hover:text-foreground hover:underline"
            >
              ← @{slug}
            </Link>
            <RangeFilter
              value={days}
              onChange={(d) =>
                void navigate({
                  to: "/agents/$slug/usage",
                  params: { slug },
                  search: d === DEFAULT_DAYS ? {} : { days: d },
                })
              }
            />
          </div>
          {!data && q.isError && (
            <ErrorLine
              text={`Couldn't load usage for @${slug}.`}
              onRetry={() => void q.refetch()}
            />
          )}
          {/* Loading keeps the chart's height so the page doesn't jump when it arrives. */}
          {!data && !q.isError && <Skeleton className="h-40" />}
          {data && data.total.turns === 0 && (
            <p className="text-sm text-muted-foreground">No usage in the last {shownDays} days.</p>
          )}
          {data && data.total.turns > 0 && (
            <>
              <div className="grid gap-3">
                <UsageTotals
                  total={data.total}
                  own={data.own}
                  persistent={data.agent.kind === "persistent"}
                />
                <EstimateLine />
              </div>
              <section className="grid min-w-0 gap-2">
                <h2 className="text-sm font-semibold">Daily</h2>
                <UsageChart
                  days={data.daily}
                  rangeDays={shownDays}
                  timezone={data.timezone}
                  today={data.daily.at(-1)?.date ?? ""}
                />
              </section>
              {data.byModel.length > 0 && <ByModelTable rows={data.byModel} />}
              {data.byTask.length > 0 && <ByTaskTable rows={data.byTask} />}
              {data.agent.kind === "persistent" && data.spawned.length > 0 && (
                <SpawnedTable rows={data.spawned} />
              )}
            </>
          )}
        </div>
      </PageBody>
    </>
  );
}
