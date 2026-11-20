import type { TaskStatus } from "@open-factory/shared";
import { inline, quoted } from "../messaging/inline.ts";

/** The rendered envelope body of a task message is capped at 64 KB of UTF-8 (quoting adds two bytes per line). */
export const TASK_BODY_CAP = 64 * 1024;
const TRUNCATED = "[truncated; call get_task for the rest]";
const bytes = (s: string) => Buffer.byteLength(s, "utf8");

/**
 * Quotes an author's text, every line prefixed `> `. When `room` bytes are not enough, the quote is cut at a line
 * boundary and the truncation marker follows it. Envelope escaping stays `groupEnvelopes`' job.
 */
function quoteBody(text: string, room: number): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const quote = lines.map((l) => `> ${l}`);
  const whole = quote.join("\n");
  if (bytes(whole) <= room) return whole;
  const budget = room - bytes(`\n${TRUNCATED}`);
  const kept: string[] = [];
  let used = 0;
  for (const l of quote) {
    const n = bytes(l) + (kept.length ? 1 : 0);
    if (used + n > budget) break;
    kept.push(l);
    used += n;
  }
  return [...kept, TRUNCATED].join("\n");
}

export type TaskAssignedInput = {
  /** Who assigned it, as `@slug` / `@handle`. */
  actor: string;
  key: string;
  title: string;
  creator: string;
  body: string;
  bodyAuthor: string;
  deps: { key: string; status: TaskStatus }[];
  blockedBy: string[];
  links: { kind: string; label: string; title?: string }[];
};

const statusWord = (s: TaskStatus) => s.replace("_", " ");

export function taskAssignedBody(i: TaskAssignedInput): string {
  const out = [`${i.actor} assigned you ${i.key}, created by ${i.creator}: ${quoted(i.title)}`];
  if (i.deps.length) {
    const deps = i.deps.map((d) => `${d.key} (${statusWord(d.status)})`).join(", ");
    out.push(
      `Depends on: ${deps}.${i.blockedBy.length ? ` Blocked by ${i.blockedBy.join(", ")}.` : ""}`,
    );
  }
  if (i.links.length) {
    const links = i.links.map(
      (l) => `${l.kind} ${inline(l.label)}${l.title ? ` ${quoted(l.title)}` : ""}`,
    );
    out.push(`Links: ${links.join(" · ")}`);
  }
  if (!i.body.trim()) return [...out, "The task has no description."].join("\n");
  const head = [...out, `The task, written by ${i.bodyAuthor}:`].join("\n");
  return `${head}\n${quoteBody(i.body, TASK_BODY_CAP - bytes(head) - 1)}`;
}

export type UpdateLine =
  | { k: "done" | "cancelled"; actor: string }
  | { k: "status"; actor: string; to: TaskStatus }
  | { k: "reassigned"; actor: string; to: string }
  | { k: "unassigned"; actor: string }
  | { k: "renamed"; actor: string; to: string }
  | { k: "edited"; actor: string }
  | { k: "unblocked"; cause: string; how: "done" | "cancelled" | "removed" };

const HOW = {
  done: "is done",
  cancelled: "was cancelled",
  removed: "was removed from its dependencies",
} as const;

export function taskUpdateBody(
  lines: UpdateLine[],
  key: string,
  title: string,
  editedBody?: { author: string; body: string },
): string {
  const out: string[] = [];
  for (const l of lines) {
    switch (l.k) {
      case "done":
        out.push(`${l.actor} marked ${key} done.`);
        break;
      case "cancelled":
        out.push(`${l.actor} cancelled ${key}.`);
        break;
      case "status":
        out.push(`${l.actor} moved ${key} to ${statusWord(l.to)}.`);
        break;
      case "reassigned":
        out.push(`${l.actor} reassigned ${key} to ${l.to}; it's no longer yours.`);
        break;
      case "unassigned":
        out.push(`${l.actor} unassigned ${key}; it's no longer yours.`);
        break;
      case "renamed":
        out.push(`${l.actor} renamed ${key} to ${quoted(l.to)}.`);
        break;
      case "edited":
        out.push(`${l.actor} edited ${key}'s description:`);
        if (editedBody) {
          const head = out.join("\n");
          out.push(
            editedBody.body.trim()
              ? quoteBody(editedBody.body, TASK_BODY_CAP - bytes(head) - 1)
              : "> (now empty)",
          );
        }
        break;
      case "unblocked":
        out.push(`${key} ${quoted(title)} is no longer blocked: ${l.cause} ${HOW[l.how]}.`);
        break;
    }
  }
  return out.join("\n");
}
