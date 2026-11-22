import type { TaskActivity } from "@open-factory/shared";
import { PrincipalChip } from "@/components/agent-chip";
import { Button } from "@/components/ui/button";
import { formatInboxTime } from "@/features/session/format";
import { ClampedMarkdown } from "@/features/session/message-block";
import { RowMenu, type RowMenuItem } from "@/features/session/row-menu";

type Comment = Extract<TaskActivity, { type: "comment" }>;

export const authorName = (c: Comment["author"]) => (c.kind === "agent" ? c.slug : c.handle);
export const authorMention = (c: Comment["author"]) => `@${authorName(c)}`;

/** A comment's menu: its deep link and its markdown source (U3 §7.5's row menu). */
function commentMenu(taskKey: string, comment: Comment): RowMenuItem[] {
  const url = `${location.origin}/tasks/${encodeURIComponent(taskKey)}?comment=${encodeURIComponent(comment.id)}`;
  return [
    { kind: "copy", label: "Copy link", text: url },
    { kind: "copy", label: "Copy text", text: comment.body },
  ];
}

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
        <span data-comment-author className="flex min-w-0 text-foreground">
          <PrincipalChip principal={comment.author} size={20} link />
        </span>
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
      <RowMenu
        items={commentMenu(taskKey, comment)}
        title={`Comment from ${who}`}
        label="Comment actions"
        focusable
        inCard
      />
    </article>
  );
}
