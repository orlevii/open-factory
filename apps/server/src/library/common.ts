/** Constants and helpers the skill-source and marketplace services share (spec §6.2, §9.4). */
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";

/** The Undo window of a removal (spec §9.4). */
export const UNDO_MS = 30_000;
/** GitHub and marketplace checkouts are at most 50 MB (spec §6.2). */
export const CHECKOUT_CAP_BYTES = 50 * 1024 * 1024;
/** Preview metadata is forgotten after a day; the sweep removes the directories sooner. */
export const META_KEEP_MS = 24 * 60 * 60 * 1000;
/** Subjects and descriptions are cut to 200 graphemes. */
export const SUBJECT_MAX = 200;
/** A full git commit id (sha-1 or sha-256). */
export const COMMIT_PATTERN = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

export const isDir = async (p: string) =>
  (await stat(p).catch(() => undefined))?.isDirectory() ?? false;

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

/** The users line of a refusal: at most three named, then "and N more". */
export function usersLine(templates: string[], agents: string[]): string {
  const all = [...templates.map((t) => `template ${t}`), ...agents.map((a) => `@${a}`)];
  const named = all.slice(0, 3);
  return all.length > 3 ? `${named.join(", ")} and ${all.length - 3} more` : named.join(", ");
}
