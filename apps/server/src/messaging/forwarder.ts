import { quoteReported } from "@open-factory/harness";
import type { FactCode, RequestRef } from "@open-factory/shared";

/**
 * One item a report forwards to its manager (spec §9.1): without `fact` the report's own text (sent as the report);
 * with one, a factory fact about the report (sent as `@factory`, `subject_agent_id` = the report). `re`: the requests
 * of the report's turn when it wrote the text (its own text only).
 */
export type Forward = { agentId: string; fact?: FactCode; body: string; re?: RequestRef[] };

export type FactDetail = {
  /** Report-controlled text, quoted (spec §9.2). */
  text?: string;
  /** The denied tool's name. */
  tool?: string;
  /** Lost background work: task descriptions and cron schedules, quoted one per line. */
  lost?: { tasks: string[]; crons: string[] };
};

/**
 * The body of a factory fact (spec §9.1), the subject written as its tag (`<@ref>`). Whatever the report controls (an error message,
 * a denial reason, `last_error`, task descriptions) is quoted by `quoteReported`, which also neutralises envelope tags.
 */
export function factFor(kind: FactCode, subject: string, detail: FactDetail = {}): string {
  // `subject` is the subject's tag, `<@ref>`.
  const who = subject;
  const reported = (lead: string, intro = `Reported by ${who}:`) =>
    detail.text !== undefined && detail.text !== ""
      ? `${lead} ${quoteReported(intro, detail.text)}`
      : lead;
  switch (kind) {
    case "turn_failed":
      return reported(`A turn of ${who} failed.`);
    case "denied":
      return reported(
        `${detail.tool ?? "A tool"} was denied for ${who}.`,
        `The reason, reported by ${who}:`,
      );
    case "crashed":
      return `${who} stopped unexpectedly during a turn; one automatic recovery is under way.`;
    case "errored":
      return reported(`${who} is errored and needs a human.`);
    case "recovered":
      return `${who} recovered.`;
    case "work_lost": {
      const lead = `Background work of ${who} was stopped.`;
      const lines = [...(detail.lost?.tasks ?? []), ...(detail.lost?.crons ?? [])];
      return lines.length
        ? `${lead} ${quoteReported(`Reported by ${who}:`, lines.join("\n"))}`
        : lead;
    }
  }
}
