import type { Cleanup, ProjectResult } from "@open-factory/shared";
import { GitBranch } from "lucide-react";
import { Fragment, type ReactNode } from "react";

export const HOST_LINE = {
  missing: "Couldn't clean up worktrees: git isn't installed on the factory host.",
  too_old: "Couldn't clean up worktrees: git 2.44 or newer is needed on the factory host.",
} as const;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "3 commits not pushed or merged" or "checked out elsewhere": why a branch was kept. */
export const keptReason = (k: ProjectResult["kept"][number]): string =>
  k.commits !== undefined
    ? `${plural(k.commits, "commit", "commits")} not pushed or merged`
    : "checked out elsewhere";

/** A branch name: mono, breaking anywhere so one long name can't widen the line. */
export const Branch = ({ name }: { name: string }) => (
  <span className="font-mono [overflow-wrap:anywhere]">{name}</span>
);

const join = (parts: ReactNode[]): ReactNode =>
  parts.map((p, i) => (
    // The parts of one sentence never reorder.
    // biome-ignore lint/suspicious/noArrayIndexKey: positional list
    <Fragment key={i}>
      {i > 0 && ", "}
      {p}
    </Fragment>
  ));

/** What happened in one project, after "<project>: ". */
function ProjectLine({ r }: { r: ProjectResult }) {
  const parts: ReactNode[] = [];
  if (r.removed) parts.push("removed the worktrees");
  if (r.deleted.length > 0)
    parts.push(<>deleted {join(r.deleted.map((b) => <Branch key={b} name={b} />))}</>);
  if (r.kept.length > 0)
    parts.push(
      <>
        kept{" "}
        {join(
          r.kept.map((k) => (
            <Fragment key={k.branch}>
              <Branch name={k.branch} /> ({keptReason(k)})
            </Fragment>
          )),
        )}
      </>,
    );
  if (r.error) parts.push(r.error);
  if (parts.length === 0) parts.push("nothing to clean up");
  return (
    <p className="pl-5 [overflow-wrap:anywhere]">
      {r.project}:{" "}
      {parts.map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: positional list
        <Fragment key={i}>
          {i > 0 && "; "}
          {p}
        </Fragment>
      ))}
    </p>
  );
}

/**
 * A terminated spawned agent's worktree cleanup (I8 §7.5): a muted factory line grouped by project. Module-level and
 * given the store's own event object, so the memoised timeline row keeps its contract.
 */
export function WorkspaceCleanupLine({
  event,
  rowProps,
}: {
  event: Cleanup;
  rowProps?: Record<string, unknown>;
}) {
  return (
    <div {...rowProps} className="text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
      <p className="flex items-center gap-1.5 [&_svg]:size-3.5 [&_svg]:shrink-0">
        <GitBranch aria-hidden="true" />
        <span className="min-w-0 [overflow-wrap:anywhere]">
          {event.host ? HOST_LINE[event.host] : "Worktree cleanup"}
        </span>
      </p>
      {event.projects.map((r) => (
        <ProjectLine key={r.project} r={r} />
      ))}
    </div>
  );
}
