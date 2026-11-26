import {
  apiFetch,
  type createScheduleBodySchema,
  type patchScheduleBodySchema,
  scheduleListSchema,
  scheduleResponseSchema,
  stopCronsResponseSchema,
} from "@open-factory/shared";
import { queryOptions } from "@tanstack/react-query";
import type { z } from "zod";

export const schedulesQueryKey = ["schedules"] as const;

/** The list's filters, as the URL carries them. */
export type ScheduleFilters = { target?: string | undefined; done?: boolean | undefined };

const queryOf = (f: ScheduleFilters) => {
  const q = new URLSearchParams();
  if (f.target) q.set("target", f.target);
  if (f.done) q.set("done", "true");
  const s = q.toString();
  return s ? `?${s}` : "";
};

export const schedulesListOptions = (f: ScheduleFilters) =>
  queryOptions({
    queryKey: [...schedulesQueryKey, "list", f.target ?? "", Boolean(f.done)] as const,
    queryFn: () => apiFetch(`/api/schedules${queryOf(f)}`, { schema: scheduleListSchema }),
  });

export const scheduleDetailOptions = (key: string) =>
  queryOptions({
    queryKey: [...schedulesQueryKey, "detail", key] as const,
    queryFn: async () =>
      (
        await apiFetch(`/api/schedules/${encodeURIComponent(key)}`, {
          schema: scheduleResponseSchema,
        })
      ).schedule,
  });

export type CreateScheduleBody = z.input<typeof createScheduleBodySchema>;
export type PatchScheduleBody = z.input<typeof patchScheduleBodySchema>;

const url = (key: string, tail = "") => `/api/schedules/${encodeURIComponent(key)}${tail}`;
const one = (path: string, method: "POST" | "PATCH" | "DELETE", body?: object) =>
  apiFetch(path, { method, ...(body ? { body } : {}), schema: scheduleResponseSchema }).then(
    (r) => r.schedule,
  );

export const createSchedule = (body: CreateScheduleBody) => one("/api/schedules", "POST", body);
export const patchSchedule = (key: string, body: PatchScheduleBody) => one(url(key), "PATCH", body);
export const pauseSchedule = (key: string) => one(url(key, "/pause"), "POST");
export const resumeSchedule = (key: string) => one(url(key, "/resume"), "POST");
export const deleteSchedule = (key: string) => one(url(key), "DELETE");
export const restoreSchedule = (key: string) => one(url(key, "/restore"), "POST");

export const stopCrons = (ref: string) =>
  apiFetch(`/api/agents/${encodeURIComponent(ref)}/stop-crons`, {
    method: "POST",
    schema: stopCronsResponseSchema,
  });
