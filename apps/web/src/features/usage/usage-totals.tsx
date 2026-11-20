import type { Totals } from "@open-factory/shared";
import type { ReactNode } from "react";
import { formatTokens } from "@/features/session/format";
import { formatCost } from "./format";

/** `18.0M` reads as `18M` in a line of figures. */
const tokens = (n: number) => formatTokens(n).replace(/\.0(?=[kM]$)/, "");

/** "1.2M in · 340k out · 2.1M cache write · 18M cache read". */
export function tokensLine(t: Totals): string {
  return [
    `${tokens(t.inputTokens)} in`,
    `${tokens(t.outputTokens)} out`,
    `${tokens(t.cacheWriteTokens)} cache write`,
    `${tokens(t.cacheReadTokens)} cache read`,
  ].join(" · ");
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-[0.8125rem] leading-[1.125rem] text-muted-foreground">{label}</dt>
      <dd className="text-sm tabular-nums">{children}</dd>
    </div>
  );
}

/**
 * The page's figures as one `<dl>` (no KPI tiles): only the estimated cost is enlarged. A persistent
 * agent with spawned usage also shows the split under the cost.
 */
export function UsageTotals({
  total,
  own,
  persistent,
}: {
  total: Totals;
  own: Totals;
  persistent: boolean;
}) {
  const spawnedTurns = total.turns - own.turns;
  return (
    <dl className="flex flex-wrap gap-x-8 gap-y-3">
      <div className="grid gap-0.5">
        <dt className="text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
          Estimated cost
        </dt>
        <dd className="text-base leading-5 font-semibold tabular-nums">
          {formatCost(total.costUsd, total.turns)}
        </dd>
        {persistent && spawnedTurns > 0 && (
          <dd className="text-[0.8125rem] leading-[1.125rem] text-muted-foreground tabular-nums">
            {`Own ${formatCost(own.costUsd, Math.max(own.turns, 1))} · spawned ${formatCost(
              total.costUsd - own.costUsd,
              spawnedTurns,
            )}`}
          </dd>
        )}
      </div>
      <Row label="Turns">{total.turns.toLocaleString("en-US")}</Row>
      <div className="basis-full text-sm tabular-nums">
        <dt className="inline text-muted-foreground">Tokens:</dt>{" "}
        <dd className="inline">{tokensLine(total)}</dd>
      </div>
    </dl>
  );
}
