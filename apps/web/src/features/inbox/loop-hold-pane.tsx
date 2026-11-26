import { ApiError } from "@open-factory/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { FormOutcome } from "@/components/forms/form-outcome";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { formatInboxTime } from "@/features/session/format";
import { FORM_MSG } from "@/lib/form-messages";
import { sessionQueryOptions } from "@/lib/session";
import { type InboxItem, useResumeHold } from "./api";

type Hold = NonNullable<InboxItem["loopHold"]>;

const messages = (n: number) => `${n} ${n === 1 ? "message" : "messages"}`;
const HANDLE = /(@[\w-]+)/;

/** The notice's text with its handles in mono. */
function withHandles(text: string): ReactNode[] {
  return text.split(HANDLE).map((part, i) =>
    // Odd indexes are the captured handles; the text around them never repeats, so the index is a stable key.
    i % 2 === 1 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: split parts have no identity
      <span key={i} className="font-mono">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

type Resumed = { by: string; at: string; sentOn: number | undefined };

/** Who resumed it and what went on: this tab's own Resume (before the refetch), else the stored hold,
 *  else a 409's body (the refetch it triggers brings `sentOn`). `me` is the viewer's "@handle". */
function resumedOf(
  hold: Hold,
  own: { sentOn: number; at: string } | undefined,
  conflict: Record<string, unknown> | undefined,
  me: string,
): Resumed | undefined {
  if (own) return { by: me, at: hold.resumedAt ?? own.at, sentOn: own.sentOn };
  if (hold.resumedAt && hold.resumedBy)
    return { by: `@${hold.resumedBy.handle}`, at: hold.resumedAt, sentOn: hold.sentOn };
  if (typeof conflict?.resumedBy === "string" && typeof conflict.resumedAt === "string")
    return { by: conflict.resumedBy, at: conflict.resumedAt, sentOn: undefined };
  return undefined;
}

function ResumedLine({
  resumed,
  me,
  statusRef,
}: {
  resumed: Resumed;
  me: string;
  statusRef: (node: HTMLParagraphElement | null) => void;
}) {
  const at = new Date(resumed.at);
  const sent =
    resumed.sentOn === undefined
      ? ""
      : resumed.sentOn > 0
        ? ` · ${messages(resumed.sentOn)} sent on`
        : " · nothing was left to send";
  return (
    <p ref={statusRef} role="status" tabIndex={-1} className="text-sm">
      Resumed
      {me !== "" && resumed.by === me ? (
        " by you"
      ) : resumed.by ? (
        <>
          {" by "}
          <span className="font-mono">{resumed.by}</span>
        </>
      ) : null}
      {" · "}
      <time dateTime={resumed.at} title={at.toLocaleString()} className="tabular-nums">
        {formatInboxTime(at, new Date())}
      </time>
      {sent}
    </p>
  );
}

/** A `loop_held` notice (I8 §6.7): the text, what is waiting, and Resume for the pair. No excerpt, no composer. */
export function LoopHoldPane({ item, hold }: { item: InboxItem; hold: Hold }) {
  const [a, b] = hold.agents;
  const m = useResumeHold(hold.id);
  const handle = useQuery(sessionQueryOptions).data?.user.handle;
  const me = handle ? `@${handle}` : "";
  const [minWidth, setMinWidth] = useState<number>();
  const focusResult = useRef(false);
  const statusEl = useRef<HTMLParagraphElement | null>(null);
  // The status line mounts when Resume answers; it takes focus then, in whichever order the two happen.
  const statusRef = useCallback((node: HTMLParagraphElement | null) => {
    statusEl.current = node;
    if (node && focusResult.current) {
      focusResult.current = false;
      node.focus();
    }
  }, []);
  const conflict = m.error instanceof ApiError && m.error.status === 409 ? m.error.body : undefined;
  const resumed = resumedOf(hold, m.data, conflict, me);
  const failed = m.isError && !conflict;
  const ended = hold.agents.filter((x) => x.status === "terminated");
  return (
    <div data-pane-body className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
      <div className="grid max-w-[52rem] justify-items-start gap-3">
        <p className="text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
          {withHandles(item.preview)}
        </p>
        {!resumed && (
          <p className="text-sm text-muted-foreground">
            {hold.waiting > 0 ? `${messages(hold.waiting)} waiting` : "Nothing is waiting"}
          </p>
        )}
        {ended.map((x) => (
          <p key={x.ref} className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
            <span className="font-mono">@{x.handle}</span> was terminated; its held messages were
            rejected.
          </p>
        ))}
        <div className="grid min-h-16 content-start justify-items-start gap-2">
          {resumed ? (
            <ResumedLine resumed={resumed} me={me} statusRef={statusRef} />
          ) : (
            <>
              <Button
                type="button"
                aria-disabled={m.isPending || undefined}
                aria-busy={m.isPending || undefined}
                className="h-auto min-h-8 py-1.5 text-left whitespace-normal"
                style={{ minWidth }}
                onClick={(e) => {
                  if (m.isPending) return;
                  setMinWidth(e.currentTarget.offsetWidth);
                  m.mutate(undefined, {
                    onSuccess: () => {
                      focusResult.current = true;
                      statusEl.current?.focus();
                    },
                  });
                }}
              >
                {m.isPending && <Spinner />}
                {m.isPending ? "Resuming…" : `Resume @${a.handle} and @${b.handle}`}
              </Button>
              {failed && (
                <FormOutcome
                  outcome={{ error: FORM_MSG.resumeFailed, outcomeKey: m.submittedAt }}
                />
              )}
            </>
          )}
        </div>
        <div className="flex flex-wrap gap-x-2 gap-y-1">
          {[a, b].map((x) => (
            <Button key={x.ref} asChild variant="ghost" size="sm" className="h-auto min-h-7 py-1">
              <Link to="/agents/$ref/session" params={{ ref: x.ref }}>
                Open @{x.handle}'s session
              </Link>
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
