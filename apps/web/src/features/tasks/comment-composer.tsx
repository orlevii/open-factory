import type { TaskCommentResponse } from "@open-factory/shared";
import { useQueryClient } from "@tanstack/react-query";
import { type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";
import { MarkdownEditor } from "@/components/markdown/markdown-editor";
import { Button } from "@/components/ui/button";
import { isCoarsePointer, isSendKey } from "@/lib/send-key";
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

// One draft per task for this tab's session, as the session composer keeps one per agent: a
// half-typed reply survives leaving the task (or the inbox item) and coming back.
const draftKey = (taskKey: string) => `of-comment-draft:${taskKey}`;
const readDraft = (taskKey: string) => {
  try {
    return sessionStorage.getItem(draftKey(taskKey)) ?? "";
  } catch {
    return "";
  }
};
const writeDraft = (taskKey: string, v: string) => {
  try {
    if (v) sessionStorage.setItem(draftKey(taskKey), v);
    else sessionStorage.removeItem(draftKey(taskKey));
  } catch {
    /* private mode */
  }
};

export type CommentComposerHandle = {
  /** Reply: the mention goes to the start of the draft (once), then the textarea takes focus. */
  reply(mention: string): void;
  /** A deep link's prefill: the mention only when the draft is still empty, no focus. */
  prefill(mention: string): void;
};

/**
 * The comment composer (UI design §7). It owns the draft, so a keystroke re-renders only the
 * composer, not the task above it; the page reaches in through the handle for Reply and the
 * `?comment=` prefill. A refetch never loses the draft (the composer stays mounted), and the draft
 * is kept per task for the tab's session, so leaving and coming back keeps it; a post clears it.
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
}) {
  const qc = useQueryClient();
  // Key the composer by task: the draft is read once per task.
  const [draft, setDraft] = useState(() => readDraft(taskKey));
  // A prefill nobody typed after isn't a draft: it isn't kept (the next deep link prefills its own).
  const prefilled = useRef<string>(undefined);
  useEffect(() => writeDraft(taskKey, draft === prefilled.current ? "" : draft), [taskKey, draft]);
  const [view, setView] = useState<"write" | "preview">("write");
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [posting, setPosting] = useState(false);
  const [failed, setFailed] = useState(false);
  const [notReached, setNotReached] = useState<string>();
  useImperativeHandle(
    ref,
    () => ({
      reply(mention) {
        setView("write");
        setDraft((d) => (d.startsWith(`${mention} `) ? d : `${mention} ${d}`));
        // After the editor (re)mounts in Write: focus and scroll, instant.
        requestAnimationFrame(() => {
          textarea.current?.focus();
          textarea.current?.scrollIntoView?.({ block: "nearest" });
        });
      },
      prefill(mention) {
        setDraft((d) => {
          if (d !== "") return d;
          prefilled.current = `${mention} `;
          return prefilled.current;
        });
      },
    }),
    [],
  );
  async function post() {
    if (posting || draft.trim() === "") return;
    const sent = draft;
    setPosting(true);
    setFailed(false);
    try {
      const r = await postComment(taskKey, sent);
      // The new comment shows at once; the refetch (not awaited) brings the rest of the task.
      qc.setQueryData(taskDetailOptions(taskKey).queryKey, (t) =>
        t && !t.activity.some((a) => a.id === r.comment.id)
          ? { ...t, activity: [...t.activity, r.comment] }
          : t,
      );
      // Keep what was typed while the post was in flight.
      setDraft((cur) => (cur === sent ? "" : cur.startsWith(sent) ? cur.slice(sent.length) : cur));
      setNotReached(notReachedLine(r.notReached));
      onPosted?.();
      void qc.invalidateQueries({ queryKey: tasksQueryKey });
    } catch {
      setFailed(true);
    } finally {
      setPosting(false);
    }
  }
  const empty = draft.trim() === "";
  const who = assignee
    ? `Goes to @${assignee} and anyone you @mention.`
    : "No assignee: only the people and agents you @mention are notified.";
  const helper = isCoarsePointer() ? who : `${who} Enter to post.`;
  return (
    <>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
        <MarkdownEditor
          id="comment-composer"
          aria-label="Comment"
          aria-describedby="comment-helper"
          value={draft}
          onChange={setDraft}
          textareaRef={textarea}
          view={view}
          onViewChange={setView}
          variant="detail"
          onKeyDown={(e) => {
            if (isSendKey(e.nativeEvent)) {
              e.preventDefault();
              if (!empty && !posting) void post();
            }
          }}
        />
        <p
          id="comment-helper"
          className="text-[0.8125rem] leading-[1.125rem] text-muted-foreground"
        >
          {helper}
        </p>
        {failed && (
          <p role="alert" className="text-[0.8125rem] leading-[1.125rem] text-destructive">
            Couldn't post the comment. Try again.
          </p>
        )}
        <div className="flex justify-end">
          <Button type="button" onClick={() => void post()} disabled={empty || posting}>
            {posting ? "Posting…" : "Comment"}
          </Button>
        </div>
      </div>
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
