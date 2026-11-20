import { Link } from "@tanstack/react-router";
import { LINK_CLASS } from "@/features/session/message-block";

/** `S-3` in mono, a link to the schedule (a deleted one opens in its deleted state), or plain text inside a link. */
export function ScheduleBadge({
  scheduleKey,
  link = true,
}: {
  scheduleKey: string;
  link?: boolean;
}) {
  const base = "font-mono text-[0.8125rem] leading-[1.125rem] text-foreground";
  if (!link) return <span className={base}>{scheduleKey}</span>;
  return (
    <Link
      to="/schedules/$key"
      params={{ key: scheduleKey }}
      aria-label={`Schedule ${scheduleKey}`}
      className={`${base} ${LINK_CLASS}`}
    >
      {scheduleKey}
    </Link>
  );
}
