import type { TaskCommentResponse } from "@open-factory/shared";
import { useQueryClient } from "@tanstack/react-query";
import { type Ref, useCallback, useImperativeHandle, useRef, useState } from "react";
import { Composer, type ComposerHandle, SubmitError } from "@/components/composer/composer";
import { taskDraftKey } from "@/lib/drafts";
import { isCoarsePointer } from "@/lib/send-key";
import { postComment, taskDetailOptions, tasksQueryKey } from "./api";

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

export const POST_FAILED = "Couldn't post the comment. Try again.";

export type CommentComposerHandle = {
  /** Reply: the mention goes to the start of the draft (once), then the textarea takes focus. */
  reply(mention: string): void;
  /** A deep link's prefill: the mention only when the draft is still empty, no focus. */
  prefill(mention: string): void;
};

/**
 * The comment composer (UI design §7) on the shared `Composer` (U3 §13.1): Write/Preview in its
 * toolbar, no attachments (a file gets the session note, Q38). The composer owns the draft, so a
 * keystroke re-renders only it, not the task above; the page reaches in through the handle for Reply
 * and the `?comment=` prefill. The draft is kept per task in `localStorage` (`of-draft:v1:task:<key>`,
 * review note m6), so leaving and coming back keeps it; what the server took leaves it.
 */
export function CommentComposer({
  ref,
  taskKey,
  assignee,
  onPosted,
}: {
  ref: Ref<CommentComposerHandle>;
  taskKey: string;
  /** After the server took the comment (the reading pane marks its item read). */
  onPosted?: () => void;
  /** The current live assignee's slug, for the helper line. */
  assignee: string | undefined;
  /** Kept for callers: the shared composer starts at two lines and grows. */
  compact?: boolean;
}) {
  const qc = useQueryClient();
  const box = useRef<ComposerHandle>(null);
  const [notReached, setNotReached] = useState<string>();
  useImperativeHandle(
    ref,
    () => ({
      reply(mention) {
        box.current?.insertAtStart(`${mention} `);
        box.current?.focus();
      },
      prefill(mention) {
        // Unfocused, so it isn't stored: a prefill nobody typed after isn't a draft.
        box.current?.prefillIfEmpty(`${mention} `);
      },
    }),
    [],
  );
  const onSubmit = useCallback(
    async (text: string) => {
      let r: TaskCommentResponse;
      try {
        r = await postComment(taskKey, text);
      } catch {
        throw new SubmitError(POST_FAILED);
      }
      // The new comment shows at once; the refetch (not awaited) brings the rest of the task.
      qc.setQueryData(taskDetailOptions(taskKey).queryKey, (t) =>
        t && !t.activity.some((a) => a.id === r.comment.id)
          ? { ...t, activity: [...t.activity, r.comment] }
          : t,
      );
      setNotReached(notReachedLine(r.notReached));
      onPosted?.();
      void qc.invalidateQueries({ queryKey: tasksQueryKey });
    },
    [qc, taskKey, onPosted],
  );
  const who = assignee
    ? `Goes to @${assignee} and anyone you @mention.`
    : "No assignee: only the people and agents you @mention are notified.";
  return (
    <>
      <Composer
        ref={box}
        draftKey={taskDraftKey(taskKey)}
        label="Comment"
        placeholder=""
        onSubmit={onSubmit}
        note={isCoarsePointer() ? who : `${who} Enter to post.`}
        preview
      />
      <p
        role="status"
        aria-live="polite"
        className="text-[0.8125rem] leading-[1.125rem] text-muted-foreground"
      >
        {notReached}
      </p>
    </>
  );
}
