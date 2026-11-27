import type { AnyEvent, ToolMeta } from "@open-factory/shared";
import { QueryClientProvider } from "@tanstack/react-query";
import { screen } from "@testing-library/react";
import { useState } from "react";
import { createQueryClient } from "@/lib/query-client";
import { se } from "@/test/session-fixtures";
import { buildRows, type ToolRow } from "../rows";
import { ToolCallRow } from "../tool-call-row";

/** Test helper: one tool call (and its result when `result` is given) as the timeline builds it. */
export function toolRow(
  name: string,
  input: unknown,
  result?: { content: string; isError?: boolean; meta?: ToolMeta },
): ToolRow {
  const events: AnyEvent[] = [{ type: "tool_call", toolUseId: "tu1", name, input }];
  if (result)
    events.push({
      type: "tool_result",
      toolUseId: "tu1",
      content: result.content,
      isError: result.isError ?? false,
      ...(result.meta ? { meta: result.meta } : {}),
    });
  const row = buildRows(events.map((e) => se(e))).rows[0];
  if (row?.kind !== "tool") throw new Error("no tool row");
  return row;
}

/** Test helper: the row as the timeline renders it (`data-row` on its own button, the body its
 *  sibling), toggling like the timeline does. */
export function RowHarness({ row, open = false }: { row: ToolRow; open?: boolean }) {
  const [expanded, setExpanded] = useState(open);
  // One client per mounted harness, so a test never reads what another left in the cache.
  const [qc] = useState(() => createQueryClient({ queries: { retry: false } }));
  return (
    <QueryClientProvider client={qc}>
      <ToolCallRow
        row={row}
        expanded={expanded}
        onToggle={() => setExpanded((x) => !x)}
        rowProps={{ "data-row": row.key }}
      />
    </QueryClientProvider>
  );
}

/** The row's toggle (its collapsed line). */
export const rowToggle = () => screen.getAllByRole("button")[0] as HTMLElement;
