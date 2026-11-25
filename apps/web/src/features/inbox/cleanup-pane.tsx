import type { Cleanup, ProjectResult } from "@open-factory/shared";
import { Copy } from "lucide-react";
import { CopyFailed, CopyIcon, useCopy } from "@/components/copy-feedback";
import { Button } from "@/components/ui/button";
import { Branch, HOST_LINE, keptReason } from "@/features/session/workspace-cleanup-line";
import type { InboxItem } from "./api";

type Kept = ProjectResult["kept"][number];

/** One kept branch: its name, why, and a Copy with the shared inline feedback. */
function KeptBranch({ k }: { k: Kept }) {
  const { state, instant, copy } = useCopy();
  return (
    <li className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <Branch name={k.branch} />
      <span className="text-muted-foreground">({keptReason(k)})</span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={state === "copied" ? `Copied ${k.branch}` : `Copy ${k.branch}`}
        // A keyboard-triggered click (Enter/Space) has detail 0: its feedback is instant.
        onClick={(e) => void copy(k.branch, e.detail === 0)}
      >
        <CopyIcon
          state={state}
          instant={instant}
          idle={<Copy aria-hidden="true" className="size-3.5" />}
        />
      </Button>
      {state === "failed" && <CopyFailed />}
    </li>
  );
}

function ProjectBlock({ r }: { r: ProjectResult }) {
  return (
    <section className="grid gap-1 text-sm">
      <h3 className="font-medium [overflow-wrap:anywhere]">{r.project}</h3>
      {r.removed && <p>Removed the worktrees.</p>}
      {r.deleted.length > 0 && (
        <p>
          Deleted{" "}
          {r.deleted.map((b, i) => (
            <span key={b}>
              {i > 0 && ", "}
              <Branch name={b} />
            </span>
          ))}
          .
        </p>
      )}
      {r.kept.length > 0 && (
        <div className="grid gap-0.5">
          <p>Kept:</p>
          <ul className="grid gap-0.5 pl-4">
            {r.kept.map((k) => (
              <KeptBranch key={k.branch} k={k} />
            ))}
          </ul>
        </div>
      )}
      {r.error && <p className="[overflow-wrap:anywhere]">{r.error}</p>}
      {!r.removed && r.deleted.length === 0 && r.kept.length === 0 && !r.error && (
        <p className="text-muted-foreground">Nothing to clean up.</p>
      )}
    </section>
  );
}

/** The heading's wording follows the notice body's rule (`noticeBody` on the server). */
function headingOf(about: string | undefined, c: Cleanup): string {
  const who = about ? `@${about}'s worktrees` : "the worktrees";
  const failed = !!c.host || c.projects.some((r) => r.error);
  const anyRemoved = c.projects.some((r) => r.removed);
  return failed || !anyRemoved ? `Couldn't fully clean up ${who}.` : `Cleaned up ${who}.`;
}

/**
 * A `worktrees_kept` notice (I8 §7.6), from `item.cleanup`, never from the body: the result per project, kept branches
 * copyable. No excerpt, no composer; the header's link opens the session at the cleanup event.
 */
export function CleanupPane({ item, cleanup }: { item: InboxItem; cleanup: Cleanup }) {
  const keptAny = cleanup.projects.some((r) => r.kept.length > 0);
  return (
    <div data-pane-body className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
      <div className="grid max-w-[52rem] gap-4">
        <p className="text-sm [overflow-wrap:anywhere]">{headingOf(item.about, cleanup)}</p>
        {cleanup.projects.map((r) => (
          <ProjectBlock key={r.project} r={r} />
        ))}
        {cleanup.host && <p className="text-sm">{HOST_LINE[cleanup.host]}</p>}
        {keptAny && (
          <p className="text-sm text-muted-foreground">
            Push them to keep the work, or delete them in the project's repository.
          </p>
        )}
      </div>
    </div>
  );
}
