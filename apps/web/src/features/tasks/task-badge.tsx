import { Link } from "@tanstack/react-router";
import { usePlainTags } from "@/components/tag/plain-tags";
import { LINK_CLASS } from "@/features/session/message-block";

/**
 * `T-42 · Plan the billing migration` (UI design §3.1): the key in mono, never truncated, the title in plain text,
 * truncated. A link to the task when `link` is given (with a comment to scroll to); plain text inside a row that is a
 * link itself.
 */
export function TaskBadge({
  taskKey,
  title,
  link,
  className = "",
}: {
  taskKey: string;
  title?: string | undefined;
  link?: boolean | { comment?: string | undefined };
  className?: string;
}) {
  const plain = usePlainTags(title ?? "");
  const body = (
    <>
      <span className="shrink-0 font-mono text-foreground">{taskKey}</span>
      {title ? (
        <>
          <span aria-hidden="true" className="mx-1 shrink-0 text-muted-foreground">
            ·
          </span>
          <span className="min-w-0 truncate text-foreground">{plain}</span>
        </>
      ) : null}
    </>
  );
  const base = `inline-flex min-w-0 max-w-full items-baseline text-[0.8125rem] leading-[1.125rem] ${className}`;
  if (!link) return <span className={base}>{body}</span>;
  const comment = typeof link === "object" ? link.comment : undefined;
  return (
    <Link
      to="/tasks/$key"
      params={{ key: taskKey }}
      search={comment ? { comment } : {}}
      aria-label={`Task ${taskKey}${title ? `: ${plain}` : ""}`}
      className={`${base} ${LINK_CLASS}`}
    >
      {body}
    </Link>
  );
}
