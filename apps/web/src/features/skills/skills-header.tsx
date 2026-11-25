import { apiFetch, type SkillGroupsResponse } from "@open-factory/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, RefreshCw } from "lucide-react";
import { type ReactNode, useState } from "react";
import { z } from "zod";
import { Elapsed } from "@/components/elapsed";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { sheetIntent } from "@/features/sheets/sheet-bodies";
import { FORM_MSG } from "@/lib/form-messages";
import { libraryQueryOptions } from "@/lib/library";
import { arrive } from "@/lib/use-arrival";
import { count } from "./format";

/** What the line needs, from the sources a check runs over: the GitHub skill sources that are ready (one still being
 *  added isn't checked). A module-level `select`: the header re-renders only when these change, not on every list
 *  refetch. */
type Summary = {
  checkingSince: string | undefined;
  sources: number;
  updates: number;
  failed: number;
};

const earliest = (a: string | undefined, b: string | undefined) =>
  a === undefined || (b !== undefined && b < a) ? b : a;

const selectSummary = (data: SkillGroupsResponse): Summary => {
  const out: Summary = { checkingSince: undefined, sources: 0, updates: 0, failed: 0 };
  for (const g of data.groups) {
    if (g.kind !== "source" || g.source.kind !== "github" || g.source.state !== "ready") continue;
    out.sources++;
    if (g.source.update) out.updates++;
    if (g.source.checkFailed) out.failed++;
    out.checkingSince = earliest(out.checkingSince, g.source.checking?.since);
  }
  return out;
};

const ADD_SKILLS_INTENT = sheetIntent("add-skills");

const checkAll = () =>
  apiFetch("/api/library/check", { method: "POST", body: {}, schema: z.object({}) });

/** "2 updates" jumps to the first row with an update on this view. */
function showFirstUpdate() {
  const row = document.querySelector<HTMLElement>("[data-update]");
  if (!row) return;
  row.scrollIntoView({ block: "center" });
  arrive(row);
}

const LINK = "underline underline-offset-2 hover:text-foreground";

type Results = { sources: number; failed: number; updates: number };

/** The finished line, from the sources' results. Updates scroll to the first one. */
function Outcome({ results }: { results: Results }) {
  const { sources, failed, updates } = results;
  if (sources === 0) return <>{FORM_MSG.noSourcesToCheck}</>;
  if (updates === 0 && failed === 0) return <>All up to date · checked just now</>;
  return (
    <>
      Checked {count(sources, "source")}
      {updates > 0 && (
        <>
          {" · "}
          <button type="button" onClick={showFirstUpdate} className={LINK}>
            {count(updates, "update")}
          </button>
        </>
      )}
      {failed > 0 && ` · ${failed} couldn't be reached`}
    </>
  );
}

/** The h1, Check for updates and Add skills (spec §10.1). The outcome line is derived from the server's check
 *  results; it sits beside the buttons, and on its own line below `sm`. */
export function SkillsHeader({ onAdd }: { onAdd?(): void }) {
  const qc = useQueryClient();
  const { data: summary } = useQuery({ ...libraryQueryOptions, select: selectSummary });
  const checkingSince = summary?.checkingSince;
  // The line shows once a check was started here or seen running (a reload mid-check keeps showing it: the running
  // state is the server's). Adjusting state while rendering, never in an effect.
  const [shown, setShown] = useState(false);
  if (!shown && checkingSince !== undefined) setShown(true);
  // The mutation stays pending until the refetch that follows has landed, so the line never reads a result that
  // predates the check.
  const check = useMutation({
    mutationFn: checkAll,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["library"] }),
  });
  const onCheck = () => {
    setShown(true);
    check.mutate();
  };
  const running = check.isPending || checkingSince !== undefined;
  let line: ReactNode = null;
  if (check.isError) line = FORM_MSG.checkFailed;
  else if (shown && summary)
    line = running ? (
      <>
        Checking…{" "}
        {checkingSince !== undefined && (
          <span aria-hidden="true">
            <Elapsed since={checkingSince} hideUnderMs={10_000} />
          </span>
        )}
      </>
    ) : (
      <Outcome results={summary} />
    );
  const add = { label: "Add skills", intent: ADD_SKILLS_INTENT };
  return (
    <PageHeader
      title="Skills"
      wrap
      wrapActions
      meta={
        <div
          role="status"
          aria-live="polite"
          className="min-w-0 flex-1 text-right text-[0.8125rem] text-muted-foreground @max-[40rem]:order-last @max-[40rem]:basis-full @max-[40rem]:text-left"
        >
          {line}
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
              <Button
                variant="ghost"
                aria-label={add.label}
                data-add-action=""
                onClick={onAdd}
                {...add.intent}
              >
                <Plus aria-hidden="true" data-icon="inline-start" />
                <span className="max-sm:sr-only">{add.label}</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent className="sm:hidden">{add.label}</TooltipContent>
          </Tooltip>
        </>
      }
    />
  );
}
