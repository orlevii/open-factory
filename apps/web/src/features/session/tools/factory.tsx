import { useMemo } from "react";
import { ScheduleBadge } from "@/features/schedules/schedule-badge";
import { TaskBadge } from "@/features/tasks/task-badge";
import type { ToolRow } from "../rows";
import { genericRenderer } from "./generic";

const PREFIX = "mcp__factory__";

/** The factory's task and schedule tools, by name: their quiet line's label, and which badge. */
const FACTORY_TOOLS = {
  create_task: { label: "Create task", badge: "task" },
  update_task: { label: "Update task", badge: "task" },
  get_task: { label: "Read task", badge: "task" },
  comment_task: { label: "Comment on task", badge: "task" },
  list_tasks: { label: "List tasks", badge: null },
  schedule_message: { label: "Schedule message", badge: "schedule" },
  list_schedules: { label: "List schedules", badge: null },
  cancel_schedule: { label: "Cancel schedule", badge: "schedule" },
} as const satisfies Record<string, { label: string; badge: "task" | "schedule" | null }>;

/** The full tool names (`mcp__factory__create_task`, …) this renderer takes. */
export const FACTORY_TOOL_NAMES = Object.keys(FACTORY_TOOLS).map((n) => PREFIX + n);

function toolOf(name: string): { label: string; badge: "task" | "schedule" | null } {
  const short = name.slice(PREFIX.length);
  return Object.hasOwn(FACTORY_TOOLS, short)
    ? FACTORY_TOOLS[short as keyof typeof FACTORY_TOOLS]
    : { label: name, badge: null };
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** A result's JSON object, or undefined (some results are plain text, like "ok: delivered"). */
function resultObject(content: string | undefined): Record<string, unknown> | undefined {
  if (!content?.trim().startsWith("{")) return undefined;
  try {
    const v: unknown = JSON.parse(content);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

const KEY = { task: /^T-\d+$/i, schedule: /^S-\d+$/i } as const;

/** The key the call is about: the input's `id` (a bare number reads as its T-/S- key), else the
 *  key the result names (a new task's `key`, a new schedule's `id`). */
function keyOf(row: ToolRow, kind: "task" | "schedule"): string | undefined {
  const fromInput = str((row.call.input as Record<string, unknown> | null)?.id);
  const result = row.state === "failed" ? undefined : resultObject(row.result?.content);
  const raw = fromInput || str(result?.key) || str(result?.id);
  if (/^\d+$/.test(raw)) return `${kind === "task" ? "T" : "S"}-${raw}`;
  return KEY[kind].test(raw) ? raw.toUpperCase() : undefined;
}

/** A quiet line: the action, muted, then the task's or schedule's badge (plain text: the row is a
 *  button), with a new task's title (spec §9.2). */
function FactorySummary({ row }: { row: ToolRow }) {
  const { label, badge } = toolOf(row.call.name);
  const key = useMemo(() => (badge ? keyOf(row, badge) : undefined), [badge, row]);
  const title =
    row.call.name === `${PREFIX}create_task`
      ? str((row.call.input as Record<string, unknown> | null)?.title)
      : "";
  return (
    <span className="flex min-w-0 flex-1 items-baseline gap-2">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      {badge === "task" && key ? (
        <TaskBadge taskKey={key} title={title || undefined} />
      ) : badge === "schedule" && key ? (
        <ScheduleBadge scheduleKey={key} link={false} />
      ) : title ? (
        <span className="min-w-0 truncate text-[0.8125rem]">{title}</span>
      ) : null}
    </span>
  );
}

/** The factory's task and schedule tools: a quiet line; the body stays the generic one. */
export const factoryRenderer = { Summary: FactorySummary, Body: genericRenderer.Body };
