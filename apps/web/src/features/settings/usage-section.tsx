import type { AgentUsageRow, CredentialsUsage, Totals, UsageDays } from "@open-factory/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { Fragment, type ReactNode, useId, useState } from "react";
import { ErrorLine } from "@/components/error-line";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { agentsUsageQuery, credentialsUsageQuery, dailyUsageQuery } from "@/features/usage/api";
import { EstimateLine } from "@/features/usage/estimate-line";
import { formatCost } from "@/features/usage/format";
import { RangeFilter } from "@/features/usage/range-filter";
import { UsageChart } from "@/features/usage/usage-chart";
import { linkClass, td, tdNum, th, thNum } from "@/features/usage/usage-tables";
import { KIND_LABEL } from "./credentials-section";
import { RATE_LIMIT_REFETCH_MS, RateLimitLine } from "./rate-limit-line";
import { SettingsSection, smallClass } from "./shared";

/** Below `md` the Agents table keeps only the agent and total columns, Credentials only name and cost. */
const wide = "hidden md:table-cell";
const cost = (t: Totals | undefined) => (t ? formatCost(t.costUsd, t.turns) : "");
const byTotal = (a: AgentUsageRow, b: AgentUsageRow) =>
  b.total.costUsd - a.total.costUsd ||
  b.total.turns - a.total.turns ||
  a.slug.localeCompare(b.slug);

/** An h3 and its real `<table>`, named by the heading. Wide tables scroll inside themselves. */
function Table({
  title,
  regionLabel,
  head,
  children,
}: {
  title: string;
  /** Names the scroll region when the heading alone would repeat another landmark's name. */
  regionLabel?: string;
  head: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className="grid min-w-0 gap-2">
      <h3 id={id} className="text-[0.8125rem] font-medium">
        {title}
      </h3>
      {/* A named region with a tab stop, so a keyboard can scroll a table wider than the screen. */}
      <section
        {...(regionLabel ? { "aria-label": regionLabel } : { "aria-labelledby": id })}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll container needs a tab stop.
        tabIndex={0}
        className="overflow-x-auto rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <table aria-labelledby={id} className="w-full border-collapse text-sm">
          <thead className="border-b">
            <tr>{head}</tr>
          </thead>
          <tbody className="[&>tr]:border-b [&>tr:last-child]:border-0">{children}</tbody>
        </table>
      </section>
    </div>
  );
}

function AgentLink({ slug }: { slug: string }) {
  return (
    <Link
      to="/agents/$slug/usage"
      params={{ slug }}
      search={{}}
      className={`${linkClass} font-mono text-[0.8125rem]`}
    >
      @{slug}
    </Link>
  );
}

function AgentRow({ a, nested }: { a: AgentUsageRow; nested?: boolean }) {
  const label = a.archived ? "Archived" : a.terminated ? "Ended" : undefined;
  return (
    <tr data-slug={a.slug}>
      <td className={`${td} ${nested ? "pl-5" : ""}`}>
        <AgentLink slug={a.slug} />
        {label && <span className="ml-2 text-[0.8125rem] text-muted-foreground">{label}</span>}
      </td>
      <td className={`${tdNum} ${wide}`}>{a.total.turns.toLocaleString("en-US")}</td>
      <td className={`${tdNum} ${wide}`}>{cost(a.own)}</td>
      {/* Spawned rows leave "spawned" blank: they can't spawn (S7). */}
      <td className={`${tdNum} ${wide}`}>{a.kind === "persistent" ? cost(a.spawned) : ""}</td>
      <td className={tdNum}>{cost(a.total)}</td>
    </tr>
  );
}

/** A full-width row holding a disclosure button (spawned children, or the no-usage fold). */
function DisclosureRow({ children, nested }: { children: ReactNode; nested?: boolean }) {
  return (
    <tr>
      <td colSpan={5} className={`py-1 ${nested ? "pl-3" : ""}`}>
        <div className="flex items-center gap-2">{children}</div>
      </td>
    </tr>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <ChevronRight
      aria-hidden="true"
      data-icon="inline-start"
      className={`transition-transform duration-150 motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
    />
  );
}

function AgentsTable({ agents }: { agents: AgentUsageRow[] }) {
  const [openSpawners, setOpenSpawners] = useState<ReadonlySet<string>>(new Set());
  const [showIdle, setShowIdle] = useState(false);

  // Spawned agents sit under their spawner (one level, S7); one whose spawner isn't listed stands alone.
  const listed = new Set(agents.map((a) => a.slug));
  const children = new Map<string, AgentUsageRow[]>();
  const tops: AgentUsageRow[] = [];
  for (const a of agents) {
    if (a.kind === "ephemeral" && a.spawnerSlug && listed.has(a.spawnerSlug)) {
      children.set(a.spawnerSlug, [...(children.get(a.spawnerSlug) ?? []), a]);
    } else tops.push(a);
  }
  const used = tops.filter((a) => a.total.turns > 0).sort(byTotal);
  const idle = tops.filter((a) => a.total.turns === 0).sort((a, b) => a.slug.localeCompare(b.slug));
  const toggle = (slug: string) =>
    setOpenSpawners((s) => {
      const next = new Set(s);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });

  return (
    <Table
      title="Agents"
      head={
        <>
          <th className={th}>Agent</th>
          <th className={`${thNum} ${wide}`}>Turns</th>
          <th className={`${thNum} ${wide}`}>Own (est.)</th>
          <th className={`${thNum} ${wide}`}>Spawned (est.)</th>
          <th className={thNum}>Total (est.)</th>
        </>
      }
    >
      {used.map((a) => {
        const kids = (children.get(a.slug) ?? []).filter((k) => k.total.turns > 0).sort(byTotal);
        const open = openSpawners.has(a.slug);
        const noun = kids.length === 1 ? "spawned agent" : "spawned agents";
        return (
          <Fragment key={a.slug}>
            <AgentRow a={a} />
            {kids.length > 0 && (
              <DisclosureRow nested>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-expanded={open}
                  onClick={() => toggle(a.slug)}
                >
                  <Chevron open={open} />
                  {/* The name stays constant; aria-expanded and the chevron carry the state. */}
                  {`Show ${kids.length} ${noun} of @${a.slug}`}
                </Button>
              </DisclosureRow>
            )}
            {open && kids.map((k) => <AgentRow key={k.slug} a={k} nested />)}
          </Fragment>
        );
      })}
      {idle.length > 0 && (
        <DisclosureRow>
          <span className={`${smallClass} text-muted-foreground`}>
            {`${idle.length} ${idle.length === 1 ? "agent" : "agents"} with no usage`}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={showIdle}
            onClick={() => setShowIdle((v) => !v)}
          >
            <Chevron open={showIdle} />
            Show
          </Button>
        </DisclosureRow>
      )}
      {showIdle && idle.map((a) => <AgentRow key={a.slug} a={a} />)}
    </Table>
  );
}

function CredentialsTable({ data }: { data: CredentialsUsage }) {
  const { credentials, unattributed } = data;
  return (
    <Table
      title="Credentials"
      regionLabel="Credential usage"
      head={
        <>
          <th className={th}>Name</th>
          <th className={`${th} ${wide}`}>Kind</th>
          <th className={thNum}>Cost (est.)</th>
          <th className={`${th} ${wide}`}>Top agents</th>
          <th className={`${th} ${wide}`}>Rate limit</th>
        </>
      }
    >
      {credentials.map((c) => {
        const rateLimit = (
          <RateLimitLine
            rateLimit={c.rateLimit}
            pausedUntil={c.pausedUntil}
            pauseExact={c.pauseExact}
          />
        );
        return (
          <tr key={c.name}>
            <td className={td}>
              <span className="font-mono text-[0.8125rem]">{c.name}</span>
              {/* Below md the rate-limit column is hidden; its line stacks under the name. */}
              <div className="mt-0.5 md:hidden">{rateLimit}</div>
            </td>
            <td className={`${td} ${wide} whitespace-nowrap text-[0.8125rem]`}>
              {KIND_LABEL[c.kind]}
            </td>
            <td className={tdNum}>{cost(c.totals)}</td>
            <td className={`${td} ${wide}`}>
              {c.agents.map((a, i) => (
                <Fragment key={a.slug}>
                  {i > 0 && ", "}
                  <AgentLink slug={a.slug} />
                </Fragment>
              ))}
            </td>
            <td className={`${td} ${wide}`}>{rateLimit}</td>
          </tr>
        );
      })}
      {/* Pre-S10 turns and turns of deleted credentials. */}
      {unattributed.turns > 0 && (
        <tr>
          <td className={`${td} text-muted-foreground`}>Unattributed</td>
          <td className={`${td} ${wide}`} />
          <td className={tdNum}>{cost(unattributed)}</td>
          <td className={`${td} ${wide}`} />
          <td className={`${td} ${wide}`} />
        </tr>
      )}
    </Table>
  );
}

/** Settings → Usage (spec §12.4): the factory's chart, agents and credentials for one range. */
export function UsageSection({
  days,
  onDaysChange,
}: {
  days: UsageDays;
  onDaysChange(days: UsageDays): void;
}) {
  // The previous range stays on screen while a switch loads.
  const daily = useQuery({ ...dailyUsageQuery(days), placeholderData: keepPreviousData });
  const agents = useQuery({ ...agentsUsageQuery(days), placeholderData: keepPreviousData });
  const credentials = useQuery({
    ...credentialsUsageQuery(days),
    placeholderData: keepPreviousData,
    // No frame announces a rate-limit reset, so the lines poll while shown.
    refetchInterval: RATE_LIMIT_REFETCH_MS,
  });
  const failed = [daily, agents, credentials].filter((q) => q.isError && !q.data);
  const d = daily.data;
  // The range the data on screen covers: the previous one while a switch loads.
  const shownDays = (d?.days.length ?? days) as UsageDays;
  const empty = d ? d.days.every((x) => x.turns === 0) : false;

  return (
    <SettingsSection id="usage" title="Usage">
      <RangeFilter value={days} onChange={onDaysChange} name="settings-usage-range" />
      {failed.length > 0 ? (
        <ErrorLine
          text="Couldn't load usage."
          onRetry={() => {
            for (const q of failed) void q.refetch();
          }}
        />
      ) : !d || !agents.data || !credentials.data ? (
        // Loading keeps the chart's height so the page doesn't jump when it arrives.
        <Skeleton className="h-40" />
      ) : (
        <>
          {empty ? (
            <p className="text-sm text-muted-foreground">No usage in the last {shownDays} days.</p>
          ) : (
            <>
              <div className="grid min-w-0 gap-2">
                <h3 className="text-[0.8125rem] font-medium">Daily</h3>
                <UsageChart
                  days={d.days}
                  rangeDays={shownDays}
                  timezone={d.timezone}
                  today={d.days.at(-1)?.date ?? ""}
                />
              </div>
              <EstimateLine />
              <AgentsTable agents={agents.data.agents} />
            </>
          )}
          {credentials.data.credentials.length > 0 || credentials.data.unattributed.turns > 0 ? (
            <CredentialsTable data={credentials.data} />
          ) : null}
        </>
      )}
    </SettingsSection>
  );
}
