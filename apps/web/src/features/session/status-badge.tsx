import type { AgentStatus } from "@open-factory/shared";
import { StatusMark } from "../../components/agent-avatar";
import { formatResetTime } from "./format";

const SHORT: Record<AgentStatus, string> = {
  hibernated: "Hibernated",
  queued: "Queued",
  rate_limited: "Rate-limited",
  working: "Working",
  idle: "Idle",
  errored: "Errored",
  terminated: "Terminated",
};

/** `working`, `queued`, `rate_limited` and `errored` draw their shared `StatusMark`; `terminated` an end state with no dot (S7 UI design §2), like Archived. */
const TOKEN = { hibernated: "hibernated", idle: "idle" } as const;
const TOKEN_REST = new Set<AgentStatus>(["hibernated", "idle"]);

type ResetInput = { rateLimitedUntil?: string | Date; rateLimitExact?: boolean };

/**
 * The one place the fallback rule lives (UI design §2): "until 14:30", or "retrying at 14:30" when
 * the window wasn't reported (`rateLimitExact: false`), so no string claims a time Claude didn't give.
 * `bare` stands alone ("retrying at 14:30"); `joined` follows "rate-limited" (", retrying at 14:30").
 */
export function resetPhrase({
  rateLimitedUntil,
  rateLimitExact,
}: ResetInput): { bare: string; joined: string } | null {
  if (!rateLimitedUntil) return null;
  const until = new Date(rateLimitedUntil);
  if (Number.isNaN(until.getTime())) return null;
  const time = formatResetTime(until, new Date());
  return rateLimitExact === false
    ? { bare: `retrying at ${time}`, joined: `, retrying at ${time}` }
    : { bare: `until ${time}`, joined: ` until ${time}` };
}

/** Long label for the session header and strip: rate-limited carries the reset time. */
export function statusLabel(
  status: AgentStatus,
  size: "long" | "short",
  reset: ResetInput = {},
): string {
  if (status !== "rate_limited" || size === "short") return SHORT[status];
  return `Rate-limited${resetPhrase(reset)?.joined ?? ""}`;
}

/** Screen-reader sentence for a status change (UI design §6). */
export function statusAnnouncement(
  name: string,
  status: AgentStatus,
  reset: ResetInput = {},
): string {
  if (status === "rate_limited")
    return `${name} is rate-limited${resetPhrase(reset)?.joined ?? ""}`;
  if (status === "terminated") return `${name} was terminated`;
  return `${name} is ${status}`;
}

/** Shape + label, never colour alone. `working` is the tooth and never a dot (DESIGN.md → The pitch);
 *  `terminated` keeps the empty 12px slot, so its label lines up with the live statuses. */
export function StatusBadge({
  status,
  rateLimitedUntil,
  rateLimitExact,
  size,
}: ResetInput & { status: AgentStatus; size: "long" | "short" }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-[0.8125rem] leading-[1.125rem] whitespace-nowrap">
      <span aria-hidden="true" className="inline-flex size-3 items-center justify-center">
        {status === "terminated" ? null : TOKEN_REST.has(status) ? (
          <span
            data-status-dot
            className="size-1.5 rounded-full"
            style={{ background: `var(--status-${TOKEN[status as keyof typeof TOKEN]})` }}
          />
        ) : (
          <StatusMark status={status} size={6} />
        )}
      </span>
      {statusLabel(status, size, { rateLimitedUntil, rateLimitExact })}
    </span>
  );
}
