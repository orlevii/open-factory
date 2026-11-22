import {
  apiFetch,
  type createTaskBodySchema,
  type patchTaskBodySchema,
  type TaskDetail,
  type TaskPage,
  type TaskStatus,
  type TaskSummary,
  taskChangeResponseSchema,
  taskCommentResponseSchema,
  taskDetailSchema,
  taskPageSchema,
} from "@open-factory/shared";
import {
  type InfiniteData,
  infiniteQueryOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import type { z } from "zod";

export const tasksQueryKey = ["tasks"] as const;

/** The list's filters, as the URL carries them. */
export type TaskFilters = {
  /** `open_in_progress` is the default (no `status` parameter); `all` shows every status. */
  status: "open_in_progress" | TaskStatus | "all";
  assignee?: string | undefined;
  unassigned?: boolean | undefined;
  creator?: string | undefined;
};

const queryOf = (f: TaskFilters, before?: string) => {
  const q = new URLSearchParams({ limit: "50" });
  if (f.status !== "open_in_progress") q.set("status", f.status);
  if (f.unassigned) q.set("unassigned", "true");
  else if (f.assignee) q.set("assignee", f.assignee);
  if (f.creator) q.set("creator", f.creator);
  if (before) q.set("before", before);
  return q.toString();
};

/** Pages are merged by `key` (first occurrence wins), so a refetch that overlaps an older page never shows a row twice. */
export const tasksListOptions = (f: TaskFilters) =>
  infiniteQueryOptions({
    queryKey: [...tasksQueryKey, "list", f] as const,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      apiFetch(`/api/tasks?${queryOf(f, pageParam)}`, { schema: taskPageSchema }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    select: (data) => {
      const seen = new Set<string>();
      return data.pages.flatMap((p) => p.tasks).filter((t) => !seen.has(t.key) && seen.add(t.key));
    },
  });

export const taskDetailOptions = (key: string) =>
  queryOptions({
    queryKey: [...tasksQueryKey, "detail", key] as const,
    queryFn: () => apiFetch(`/api/tasks/${encodeURIComponent(key)}`, { schema: taskDetailSchema }),
  });

/** The task's row from any cached list page, so its page can render the title and status while the
 *  detail loads (spec §11). A plain cache read: it does not subscribe. */
export function taskSummaryFromList(qc: QueryClient, key: string): TaskSummary | undefined {
  const lists = qc.getQueriesData<InfiniteData<TaskPage>>({ queryKey: [...tasksQueryKey, "list"] });
  for (const [, data] of lists) {
    for (const page of data?.pages ?? []) {
      const hit = page.tasks.find((t) => t.key === key);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** A detail stand-in built from a list row: the row's fields, and nothing it doesn't know (no body,
 *  relations, links or activity). Only ever shown as `isPlaceholderData`, never edited from. */
export const taskPlaceholder = (s: TaskSummary): TaskDetail => ({
  ...s,
  body: "",
  createdAt: s.updatedAt,
  dependsOn: [],
  blocks: [],
  links: [],
  activity: [],
  usage: null,
});

export type CreateTaskBody = z.input<typeof createTaskBodySchema>;
export type PatchTaskBody = z.input<typeof patchTaskBodySchema>;

export const createTask = (body: CreateTaskBody) =>
  apiFetch("/api/tasks", { method: "POST", body, schema: taskChangeResponseSchema });

export const patchTask = (key: string, body: PatchTaskBody) =>
  apiFetch(`/api/tasks/${encodeURIComponent(key)}`, {
    method: "PATCH",
    body,
    schema: taskChangeResponseSchema,
  });

export const postComment = (key: string, body: string) =>
  apiFetch(`/api/tasks/${encodeURIComponent(key)}/comments`, {
    method: "POST",
    body: { body },
    schema: taskCommentResponseSchema,
  });

/** One request for the dependency editor's keys. */
export const lookupTasks = (keys: string[]) =>
  apiFetch(`/api/tasks?status=all&keys=${encodeURIComponent(keys.join(","))}&limit=50`, {
    schema: taskPageSchema,
  }).then((p) => p.tasks);
