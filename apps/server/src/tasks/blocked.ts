import type { TaskStatus } from "@open-factory/shared";

const settled = (s: TaskStatus) => s === "done" || s === "cancelled";

/** Spec §6.2: blocked while open or in progress and some dependency is neither done nor cancelled. */
export const isBlocked = (status: TaskStatus, depStatuses: TaskStatus[]): boolean =>
  (status === "open" || status === "in_progress") && depStatuses.some((s) => !settled(s));

export const blockedBy = (
  status: TaskStatus,
  deps: { key: string; status: TaskStatus }[],
): string[] =>
  status === "open" || status === "in_progress"
    ? deps.filter((d) => !settled(d.status)).map((d) => d.key)
    : [];
