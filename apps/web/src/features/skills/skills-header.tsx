import { apiFetch, type SkillGroupsResponse } from "@open-factory/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Plus, RefreshCw } from "lucide-react";
import { type ReactNode, useState } from "react";
import { z } from "zod";
import { Elapsed } from "@/components/elapsed";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { SegmentedLinks } from "@/components/ui/segmented-links";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { sheetIntent } from "@/features/sheets/sheet-bodies";
import { FORM_MSG } from "@/lib/form-messages";
import {
  libraryQueryOptions,
  type MarketplacesResponse,
  marketplacesQueryOptions,
} from "@/lib/library";
import { arrive } from "@/lib/use-arrival";
import { count } from "./format";

/** What the line needs, from the sources a check runs over: the GitHub skill sources and the git or GitHub marketplaces
 *  that are ready (one still being added isn't checked). Module-level `select`s: the header re-renders only when these
 *  change, not on every list refetch. */
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

const selectMarketplaceSummary = (data: MarketplacesResponse): Summary => {
  const out: Summary = { checkingSince: undefined, sources: 0, updates: 0, failed: 0 };
  for (const m of data.marketplaces) {
    if (m.source.source === "directory" || m.state !== "ready") continue;
    out.sources++;
    if (m.updateCommit) out.updates++;
    if (m.checkError) out.failed++;
    out.checkingSince = earliest(out.checkingSince, m.checking?.since);
  }
  return out;
};

export type SkillsView = "skills" | "plugins" | "marketplaces";

const VIEWS = [
  { to: "/skills", label: "Skills" },
  { to: "/skills/plugins", label: "Plugins" },
  { to: "/skills/marketplaces", label: "Marketplaces" },
] as const;
const VIEW_LABEL: Record<SkillsView, string> = {
  skills: "Skills",
  plugins: "Plugins",
  marketplaces: "Marketplaces",
};
const VIEW_PATH: Record<SkillsView, string> = {
  skills: "/skills",
  plugins: "/skills/plugins",
  marketplaces: "/skills/marketplaces",
};

/** The view switch (spec §10.1): links in a labelled nav; below about 16rem of header (390px at 200% text) a `Select`
 *  of the same three views takes their place, and from 24rem down the switch has a line of its own. */
function ViewSwitch({ view }: { view: SkillsView }) {
  const navigate = useNavigate();
  return (
    <>
      <SegmentedLinks
        label="Skills views"
        items={VIEWS}
        className="shrink-0 @max-[24rem]:order-last @max-[24rem]:basis-full @max-[16rem]:hidden"
      />
      <div className="hidden min-w-0 @max-[16rem]:order-last @max-[16rem]:block @max-[16rem]:basis-full">
        <Select
          value={view}
          onValueChange={(v) => void navigate({ to: VIEW_PATH[v as SkillsView] })}
        >
          <SelectTrigger aria-label="Skills views">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(VIEW_LABEL) as SkillsView[]).map((v) => (
              <SelectItem key={v} value={v}>
                {VIEW_LABEL[v]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </>
  );
}

const ADD_SKILLS_INTENT = sheetIntent("add-skills");
const ADD_MARKETPLACE_INTENT = sheetIntent("add-marketplace");

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

type Results = { sources: number; failed: number; skills: number; marketplaces: number };

/** The finished line, from the sources' and marketplaces' results. Updates on this view scroll to the first one; those on
 *  another view name it and link there ("2 updates in Marketplaces"). */
function Outcome({ results, view }: { results: Results; view: SkillsView }) {
  const { sources, failed, skills, marketplaces } = results;
  if (sources === 0) return <>{FORM_MSG.noSourcesToCheck}</>;
  if (skills + marketplaces === 0 && failed === 0) return <>All up to date · checked just now</>;
  const here = view === "skills" ? skills : view === "marketplaces" ? marketplaces : 0;
  return (
    <>
      Checked {count(sources, "source")}
      {here > 0 && (
        <>
          {" · "}
          <button type="button" onClick={showFirstUpdate} className={LINK}>
            {count(here, "update")}
          </button>
        </>
      )}
      {view !== "skills" && skills > 0 && (
        <>
          {" · "}
          <Link to="/skills" className={LINK}>
            {count(skills, "update")} in Skills
          </Link>
        </>
      )}
      {view !== "marketplaces" && marketplaces > 0 && (
        <>
          {" · "}
          <Link to="/skills/marketplaces" className={LINK}>
            {count(marketplaces, "update")} in Marketplaces
          </Link>
        </>
      )}
      {failed > 0 && ` · ${failed} couldn't be reached`}
    </>
  );
}

/** The h1, the view switch, Check for updates and the view's add action (spec §10.1): Add skills on Skills, Add
 *  marketplace on Marketplaces, none on Plugins (plugins come from marketplaces). The outcome line is derived from the
 *  server's check results; it sits beside the buttons, and on its own line below `sm`. */
export function SkillsHeader({ view, onAdd }: { view: SkillsView; onAdd?(): void }) {
  const qc = useQueryClient();
  const { data: skillSummary } = useQuery({ ...libraryQueryOptions, select: selectSummary });
  const { data: marketSummary } = useQuery({
    ...marketplacesQueryOptions,
    select: selectMarketplaceSummary,
  });
  const checkingSince = earliest(skillSummary?.checkingSince, marketSummary?.checkingSince);
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
  else if (shown && skillSummary)
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
      <Outcome
        view={view}
        results={{
          sources: skillSummary.sources + (marketSummary?.sources ?? 0),
          failed: skillSummary.failed + (marketSummary?.failed ?? 0),
          skills: skillSummary.updates,
          marketplaces: marketSummary?.updates ?? 0,
        }}
      />
    );
  const add =
    view === "skills"
      ? { label: "Add skills", intent: ADD_SKILLS_INTENT }
      : view === "marketplaces"
        ? { label: "Add marketplace", intent: ADD_MARKETPLACE_INTENT }
        : undefined;
  return (
    <PageHeader
      title="Skills"
      wrap
      wrapActions
      meta={
        <>
          <ViewSwitch view={view} />
          <div
            role="status"
            aria-live="polite"
            className="min-w-0 flex-1 text-right text-[0.8125rem] text-muted-foreground @max-[40rem]:order-last @max-[40rem]:basis-full @max-[40rem]:text-left"
          >
            {line}
          </div>
        </>
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
          {add && (
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
          )}
        </>
      }
    />
  );
}
