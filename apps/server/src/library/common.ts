/** Constants and helpers the skill-source services share (spec §6.2, §9.4). */
import { createHash } from "node:crypto";
import { stat, utimes } from "node:fs/promises";
import { cutGraphemes } from "@open-factory/shared";
import { ApiError } from "../errors.ts";
import { redactOutput } from "../redact.ts";
import { GitError } from "./git.ts";

/** The Undo window of a removal (spec §9.4). */
export const UNDO_MS = 30_000;
/** GitHub checkouts are at most 50 MB (spec §6.2). */
export const CHECKOUT_CAP_BYTES = 50 * 1024 * 1024;
/** A checkout holds at most this many files and folders: a bound on the walks over it (size, copy, listing). */
export const CHECKOUT_MAX_ENTRIES = 50_000;
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

/**
 * What a failed update check records on the row (spec §10.1): a git or validation message, redacted and cut, or
 * `fallback` for anything unexpected.
 */
export function checkErrorText(e: unknown, fallback: string): string {
  return cutGraphemes(
    e instanceof GitError || e instanceof ApiError ? redactOutput(e.message) : fallback,
    SUBJECT_MAX,
  );
}

/** Marks a staged update copy as in use, so the hourly preview purge doesn't take it while a check reads it. */
export async function touchDir(dir: string): Promise<void> {
  const now = new Date();
  await utimes(dir, now, now).catch(() => {});
}
