import type { AgentStatus } from "@open-factory/shared";
import { formatResetTime } from "./format";

const SHORT: Record<AgentStatus, string> = {
  hibernated: "Hibernated",
  queued: "Queued",
  rate_limited: "Rate-limited",
  working: "Working",
  idle: "Idle",
  errored: "Errored",
};

const TOKEN: Record<Exclude<AgentStatus, "working">, string> = {
  hibernated: "hibernated",
  queued: "queued",
  idle: "idle",
  rate_limited: "rate-limited",
  errored: "errored",
};

type ResetInput = { rateLimitedUntil?: string | Date; rateLimitExact?: boolean };

function resetPhrase({ rateLimitedUntil, rateLimitExact }: ResetInput, now: Date): string | null {
  if (!rateLimitedUntil) return null;
  const until = new Date(rateLimitedUntil);
  if (Number.isNaN(until.getTime())) return null;
  const time = formatResetTime(until, now);
  // A fallback window never claims a time Claude didn't report (UI design §2).
  return rateLimitExact === false ? `retrying at ${time}` : `until ${time}`;
}

/** Long label for the session header and strip: rate-limited carries the reset time. */
export function statusLabel(
  status: AgentStatus,
  size: "long" | "short",
  reset: ResetInput = {},
  now: Date = new Date(),
): string {
  if (status !== "rate_limited" || size === "short") return SHORT[status];
  const phrase = resetPhrase(reset, now);
  if (!phrase) return SHORT[status];
  return reset.rateLimitExact === false ? `Rate-limited, ${phrase}` : `Rate-limited ${phrase}`;
}

/** Screen-reader sentence for a status change (UI design §6). */
export function statusAnnouncement(
  name: string,
  status: AgentStatus,
  reset: ResetInput = {},
  now: Date = new Date(),
): string {
  if (status === "rate_limited") {
    const phrase = resetPhrase(reset, now);
    if (phrase)
      return `${name} is rate-limited${reset.rateLimitExact === false ? "," : ""} ${phrase}`;
    return `${name} is rate-limited`;
  }
  return `${name} is ${status}`;
}

/** Shape + label, never colour alone. `working` is the tooth and never a dot (DESIGN.md → The pitch). */
export function StatusBadge({
  status,
  rateLimitedUntil,
  rateLimitExact,
  size = "short",
}: ResetInput & { status: AgentStatus; size?: "long" | "short" }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[0.8125rem] leading-[1.125rem]">
      <span aria-hidden="true" className="inline-flex size-3 items-center justify-center">
        {status === "working" ? (
          <span className="of-tooth" />
        ) : (
          <span
            data-status-dot
            className="size-1.5 rounded-full"
            style={{ background: `var(--status-${TOKEN[status]})` }}
          />
        )}
      </span>
      {statusLabel(status, size, { rateLimitedUntil, rateLimitExact })}
    </span>
  );
}
