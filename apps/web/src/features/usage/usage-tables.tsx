import type { AgentUsage, Totals } from "@open-factory/shared";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useId } from "react";
import { formatTokens } from "@/features/session/format";
import { formatCost } from "./format";

export const linkClass =
  "underline underline-offset-4 decoration-muted-foreground hover:decoration-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm";
export const th =
  "py-1.5 pr-4 text-left text-[0.8125rem] font-normal text-muted-foreground last:pr-0";
export const thNum = `${th} text-right`;
export const td = "py-1.5 pr-4 align-top last:pr-0";
export const tdNum = `${td} text-right tabular-nums`;

const allTokens = (t: Totals) =>
  t.inputTokens + t.outputTokens + t.cacheWriteTokens + t.cacheReadTokens;

/** An h2 and its real `<table>`, named by the heading; `note` sits between them. */
function Section({
  title,
  note,
  head,
  children,
}: {
  title: string;
  note?: string;
  head: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className="grid min-w-0 gap-2">
      <h2 id={id} className="text-sm font-semibold">
        {title}
      </h2>
      {note && <p className="text-[0.8125rem] leading-[1.125rem] text-muted-foreground">{note}</p>}
      {/* Wide tables scroll inside themselves rather than widening the page on a phone. */}
      <div className="overflow-x-auto">
        <table aria-labelledby={id} className="w-full border-collapse text-sm">
          <thead className="border-b">
            <tr>{head}</tr>
          </thead>
          <tbody className="[&>tr]:border-b [&>tr:last-child]:border-0">{children}</tbody>
        </table>
      </div>
    </section>
  );
}

export function ByModelTable({ rows }: { rows: AgentUsage["byModel"] }) {
  return (
    <Section
      title="By model"
      head={
        <>
          <th className={th}>Model</th>
          <th className={thNum}>Turns</th>
          <th className={thNum}>Tokens</th>
          <th className={thNum}>Cost (est.)</th>
        </>
      }
    >
      {rows.map((r) => (
        <tr key={r.model ?? ""}>
          <td className={td}>
            {/* A turn that never reported its model (the server keeps it as null). */}
            {r.model === null ? (
              <span className="text-muted-foreground">Unknown model</span>
            ) : (
              <span className="font-mono text-[0.8125rem]">{r.model}</span>
            )}
          </td>
          <td className={tdNum}>{r.turns.toLocaleString("en-US")}</td>
          <td className={tdNum}>{formatTokens(allTokens(r))}</td>
          <td className={tdNum}>{formatCost(r.costUsd, r.turns)}</td>
        </tr>
      ))}
    </Section>
  );
}

export function ByTaskTable({ rows }: { rows: AgentUsage["byTask"] }) {
  return (
    <Section
      title="By task"
      note="Counts only turns that handled this task's messages and nothing else. Real usage can be higher."
      head={
        <>
          <th className={th}>Task</th>
          <th className={th}>Title</th>
          <th className={thNum}>Turns</th>
          <th className={thNum}>Cost (est.)</th>
        </>
      }
    >
      {rows.map((r) => (
        <tr key={r.key}>
          <td className={`${td} whitespace-nowrap font-mono text-[0.8125rem]`}>
            <Link to="/tasks/$key" params={{ key: r.key }} className={linkClass}>
              {r.key}
            </Link>
          </td>
          <td className={td}>{r.title}</td>
          <td className={tdNum}>{r.turns.toLocaleString("en-US")}</td>
          <td className={tdNum}>{formatCost(r.costUsd, r.turns)}</td>
        </tr>
      ))}
    </Section>
  );
}

export function SpawnedTable({ rows }: { rows: AgentUsage["spawned"] }) {
  return (
    <Section
      title="Spawned agents"
      head={
        <>
          <th className={th}>Agent</th>
          <th className={thNum}>Turns</th>
          <th className={thNum}>Cost (est.)</th>
        </>
      }
    >
      {rows.map((r) => (
        <tr key={r.slug}>
          <td className={td}>
            <Link
              to="/agents/$slug/usage"
              params={{ slug: r.slug }}
              search={{}}
              className={`${linkClass} font-mono text-[0.8125rem]`}
            >
              @{r.slug}
            </Link>
            {r.terminated && (
              <span className="ml-2 text-[0.8125rem] text-muted-foreground">Ended</span>
            )}
          </td>
          <td className={tdNum}>{r.turns.toLocaleString("en-US")}</td>
          <td className={tdNum}>{formatCost(r.costUsd, r.turns)}</td>
        </tr>
      ))}
    </Section>
  );
}
