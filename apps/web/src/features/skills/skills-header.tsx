import { apiFetch, type SkillGroupsResponse } from "@open-factory/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, RefreshCw } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import { Elapsed } from "@/components/elapsed";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { libraryQueryOptions } from "@/lib/library";
import { arrive } from "@/lib/use-arrival";
import { count } from "./format";

type Checked = { id: string; checkedAt: string | null; update: boolean; failed: boolean };

/** The GitHub sources, which are what a check runs over (a folder has nothing to check). A module-level `select`:
 *  the header re-renders only when a source's check result changes, not on every list refetch. */
const selectChecked = (data: SkillGroupsResponse): Checked[] =>
  data.groups.flatMap((g) =>
    g.kind === "source" && g.source.kind === "github"
      ? [
          {
            id: g.source.id,
            checkedAt: g.source.checkedAt,
            update: g.source.update,
            failed: g.source.checkFailed,
          },
        ]
      : [],
  );

const checkAll = () =>
  apiFetch("/api/library/check", { method: "POST", body: {}, schema: z.object({}) });

/** A check in this page's session: when it was started, and what each source's `checkedAt` was then. A source is
 *  done when its `checkedAt` has changed, so a skewed clock between browser and server doesn't matter. */
type Run = { startedAt: string; before: Record<string, string | null> };

/** "2 updates" jumps to the first source with an update on this view. */
function showFirstUpdate() {
  const row = document.querySelector<HTMLElement>("[data-update]");
  if (!row) return;
  row.scrollIntoView({ block: "center" });
  arrive(row);
}

function Outcome({ checked, run }: { checked: Checked[]; run: Run }) {
  if (checked.length === 0) return <>No sources to check.</>;
  if (checked.some((c) => c.checkedAt === run.before[c.id]))
    return (
      <>
        Checking… <Elapsed since={run.startedAt} hideUnderMs={10_000} />
      </>
    );
  const updates = checked.filter((c) => c.update).length;
  const failed = checked.filter((c) => c.failed).length;
  if (updates === 0 && failed === 0) return <>All up to date · checked just now</>;
  return (
    <>
      Checked {count(checked.length, "source")}
      {updates > 0 && (
        <>
          {" · "}
          <button
            type="button"
            onClick={showFirstUpdate}
            className="underline underline-offset-2 hover:text-foreground"
          >
            {count(updates, "update")}
          </button>
        </>
      )}
      {failed > 0 && ` · ${failed} couldn't be reached`}
    </>
  );
}

/** The h1, Check for updates and Add skills (spec §10.1). PR 1 has one view, so no view switch. The outcome line is
 *  derived from the sources' check results; it sits beside the buttons, and on its own line below `sm`. */
export function SkillsHeader({ onAddSkills }: { onAddSkills(): void }) {
  const { data: checked = [] } = useQuery({ ...libraryQueryOptions, select: selectChecked });
  const [run, setRun] = useState<Run>();
  const check = useMutation({ mutationFn: checkAll });
  const onCheck = () => {
    setRun({
      startedAt: new Date().toISOString(),
      before: Object.fromEntries(checked.map((c) => [c.id, c.checkedAt])),
    });
    check.mutate();
  };
  return (
    <PageHeader
      title="Skills"
      wrap
      meta={
        <div
          role="status"
          aria-live="polite"
          className="min-w-0 flex-1 text-right text-[0.8125rem] text-muted-foreground empty:hidden @max-[40rem]:order-last @max-[40rem]:basis-full @max-[40rem]:text-left"
        >
          {check.isError ? (
            "Couldn't check for updates."
          ) : run ? (
            <Outcome checked={checked} run={run} />
          ) : null}
        </div>
      }
      actions={
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                aria-label="Check for updates"
                disabled={check.isPending}
                onClick={onCheck}
              >
                <RefreshCw aria-hidden="true" data-icon="inline-start" />
                <span className="max-sm:sr-only">Check for updates</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent className="sm:hidden">Check for updates</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" aria-label="Add skills" onClick={onAddSkills}>
                <Plus aria-hidden="true" data-icon="inline-start" />
                <span className="max-sm:sr-only">Add skills</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent className="sm:hidden">Add skills</TooltipContent>
          </Tooltip>
        </>
      }
    />
  );
}
