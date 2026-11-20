import type { TaskCommentResponse } from "@open-factory/shared";
import type { RefObject } from "react";
import { MarkdownEditor } from "@/components/markdown/markdown-editor";
import { Button } from "@/components/ui/button";

const REASON: Record<string, string> = {
  unknown: "no such name",
  ambiguous: "matches more than one",
  archived: "archived",
  terminated: "terminated",
  reserved: "reserved name",
};

/** "Not reached: @x (no such name), @y (archived), and 3 more (over 50 mentions)." (only the reasons present). */
export function notReachedLine(list: TaskCommentResponse["notReached"]): string | undefined {
  if (!list.length) return undefined;
  const many = list.filter((n) => n.reason === "too_many").length;
  const named = list
    .filter((n) => n.reason !== "too_many")
    .map((n) => `@${n.name} (${REASON[n.reason] ?? n.reason})`);
  const more = many ? `${many} more (over 50 mentions)` : undefined;
  const parts = more ? (named.length ? [...named, `and ${more}`] : [more]) : named;
  return `Not reached: ${parts.join(", ")}.`;
}

/** The comment composer (UI design §7). Its draft lives in the page, so a refetch never loses it. */
export function CommentComposer({
  value,
  onChange,
  onSubmit,
  pending,
  failed,
  assignee,
  view,
  onViewChange,
  textareaRef,
}: {
  value: string;
  onChange(v: string): void;
  onSubmit(): void;
  pending: boolean;
  failed: boolean;
  /** The current live assignee's slug, for the helper line. */
  assignee: string | undefined;
  view: "write" | "preview";
  onViewChange(v: "write" | "preview"): void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const empty = value.trim() === "";
  const helper = assignee
    ? `Goes to @${assignee} and anyone you @mention.`
    : "No assignee: only the people and agents you @mention are notified.";
  return (
    <div className="grid gap-2">
      <MarkdownEditor
        id="comment-composer"
        aria-label="Comment"
        aria-describedby="comment-helper"
        value={value}
        onChange={onChange}
        textareaRef={textareaRef}
        view={view}
        onViewChange={onViewChange}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !empty && !pending) {
            e.preventDefault();
            onSubmit();
          }
        }}
      />
      <p id="comment-helper" className="text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
        {helper}
      </p>
      {failed && (
        <p role="alert" className="text-[0.8125rem] leading-[1.125rem] text-destructive">
          Couldn't post the comment. Try again.
        </p>
      )}
      <div className="flex justify-end">
        <Button type="button" onClick={onSubmit} disabled={empty || pending}>
          {pending ? "Posting…" : "Comment"}
        </Button>
      </div>
    </div>
  );
}
