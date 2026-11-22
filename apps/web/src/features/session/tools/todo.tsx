import { Check } from "lucide-react";
import { useMemo } from "react";
import type { ToolRow } from "../rows";

type Todo = { content: string; status: "pending" | "in_progress" | "completed" };

/** The checklist is the call's input (TodoWrite's result carries nothing, spec §9.1); items without
 *  text are skipped, an unknown status reads as pending. */
function todosOf(input: unknown): Todo[] | undefined {
  const list = (input as Record<string, unknown> | null)?.todos;
  if (!Array.isArray(list)) return undefined;
  const out: Todo[] = [];
  for (const t of list) {
    if (!t || typeof t !== "object") continue;
    const { content, status } = t as Record<string, unknown>;
    if (typeof content !== "string" || !content.trim()) continue;
    out.push({
      content,
      status: status === "completed" || status === "in_progress" ? status : "pending",
    });
  }
  return out;
}

const useTodos = (row: ToolRow) => useMemo(() => todosOf(row.call.input), [row.call.input]);

/** "Updated plan · 3/7 done". */
function TodoSummary({ row }: { row: ToolRow }) {
  const todos = useTodos(row);
  const done = todos?.filter((t) => t.status === "completed").length ?? 0;
  return (
    <span className="min-w-0 flex-1 truncate">
      Updated plan
      {todos && todos.length > 0 && (
        <span className="text-muted-foreground">
          {" "}
          · {done}/{todos.length} done
        </span>
      )}
    </span>
  );
}

/** Each box's state in words, for assistive tech; the box itself is decoration. */
const STATUS = { completed: "Done", in_progress: "In progress", pending: "To do" } as const;

/** The checklist, read-only: graphite boxes, filled when done, half-filled in progress. Not
 *  checkboxes (nothing here can be ticked): each item says its state to a screen reader. */
function TodoBody({ row }: { row: ToolRow }) {
  const todos = useTodos(row);
  if (!todos?.length) return null;
  return (
    <ul className="space-y-1">
      {todos.map((t, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a static list; items may repeat
        <li key={i} data-status={t.status} className="flex items-start gap-2 text-sm leading-5">
          <span
            aria-hidden="true"
            className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-primary ${t.status === "completed" ? "bg-primary text-primary-foreground" : ""}`}
          >
            {t.status === "completed" ? (
              <Check className="size-3" strokeWidth={3} />
            ) : t.status === "in_progress" ? (
              <span className="size-2 rounded-[2px] bg-primary" />
            ) : null}
          </span>
          <span
            dir="auto"
            className={`min-w-0 [overflow-wrap:anywhere] ${t.status === "completed" ? "text-muted-foreground" : ""}`}
          >
            <span className="sr-only">{STATUS[t.status]}: </span>
            {t.content}
          </span>
        </li>
      ))}
    </ul>
  );
}

export const todoRenderer = { Summary: TodoSummary, Body: TodoBody };
