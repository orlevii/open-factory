import type { TaskActivity } from "@open-factory/shared";
import { Button } from "@/components/ui/button";
import { CopyLink } from "@/features/session/copy-link";
import { formatInboxTime } from "@/features/session/format";
import { AgentLink, ClampedMarkdown } from "@/features/session/message-block";

type Comment = Extract<TaskActivity, { type: "comment" }>;

export const authorName = (c: Comment["author"]) => (c.kind === "agent" ? c.slug : c.handle);
export const authorMention = (c: Comment["author"]) => `@${authorName(c)}`;

/** One comment (UI design §7): S3's message block, with Reply and a link to this comment. */
export function CommentBlock({
  taskKey,
  comment,
  now,
  highlighted,
  onReply,
}: {
  taskKey: string;
  comment: Comment;
  now: Date;
  highlighted: boolean;
  onReply(mention: string): void;
}) {
  const who = authorMention(comment.author);
  const at = new Date(comment.at);
  return (
    <article
      id={`comment-${comment.id}`}
      aria-label={`Comment from ${who}`}
      tabIndex={-1}
      {...(highlighted ? { "data-highlighted": "true" } : {})}
      className={`group relative rounded-lg border border-border px-3 py-2 pr-9 outline-none ${highlighted ? "bg-[color-mix(in_oklab,var(--signal)_26%,transparent)]" : ""}`} // ui-contract:allow programmatic focus target, not interactive
    >
      <div className="mb-1 flex flex-wrap items-center gap-x-2 text-[0.8125rem] leading-[1.125rem]">
        {comment.author.kind === "agent" ? (
          <span>
            <AgentLink slug={comment.author.slug} name />
          </span>
        ) : (
          <span className="font-mono text-foreground">{who}</span>
        )}
        <time dateTime={comment.at} title={at.toLocaleString()} className="text-muted-foreground">
          {formatInboxTime(at, now)}
        </time>
        <Button
          variant="ghost"
          size="xs"
          aria-label={`Reply to ${who}`}
          className="ml-auto"
          onClick={() => onReply(who)}
        >
          Reply
        </Button>
      </div>
      <ClampedMarkdown source={comment.body} />
      <CopyLink
        url={`${location.origin}/tasks/${encodeURIComponent(taskKey)}?comment=${encodeURIComponent(comment.id)}`}
        label="Copy link to this comment"
        focusable
      />
    </article>
  );
}
