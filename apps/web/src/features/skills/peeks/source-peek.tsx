import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { ErrorLine } from "@/components/error-line";
import { MiddleTruncate } from "@/components/middle-truncate";
import { Button } from "@/components/ui/button";
import { SheetBody, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { notify } from "@/components/ui/toaster";
import { UntrustedProse, visibleControls } from "@/components/untrusted-text";
import { TimeAgo } from "@/features/settings/shared";
import { FORM_MSG } from "@/lib/form-messages";
import {
  addSkillsTo,
  checkSource,
  findSkills,
  libraryQueryOptions,
  refetchSource,
  removeSource,
  restoreSource,
  selectSourceGroup,
  sourceQueryOptions,
  updateSource,
} from "@/lib/library";
import { AddSkillsResults, type Found, useTicks } from "../add-skills-results";
import { count, pinLabel, sourceLabel, usedByText } from "../format";
import { RowState } from "../row-state";
import { skillKey } from "../use-peek";
import {
  BackButton,
  failure,
  type Line,
  Outcome,
  Pending,
  PinButton,
  Section,
  SkeletonRows,
} from "./sections";
import { UpdateView } from "./update-view";

/**
 * Find more skills (spec §10.3): the Add skills results step inline, with the source fixed. Its outcome is inline
 * because the control is still on screen, and there is no toast and no Undo. Find and Add are mutations from handlers
 * (R-Q1); ticks are a `Set` updated functionally, and the filtered state is derived during render (R-F1).
 */
function FindMore({ id }: { id: string }) {
  const qc = useQueryClient();
  const [found, setFound] = useState<{ list: Found[]; seq: number }>();
  const [filter, setFilter] = useState("");
  const { ticked, setTicked, onTick, onToggle } = useTicks();
  const [line, setLine] = useState<Line>();
  const find = useMutation({ mutationFn: () => findSkills(id) });
  const add = useMutation({
    mutationFn: (names: string[]) => addSkillsTo(id, names),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["library"] }),
  });
  const onFind = () => {
    setLine(undefined);
    find.mutate(undefined, {
      onSuccess: (r) => {
        setFound((p) => ({ list: r.found, seq: (p?.seq ?? 0) + 1 }));
        setFilter("");
        setTicked(new Set(r.found.filter((f) => f.pickable).map((f) => f.name)));
        if (r.found.length === 0) setLine({ tone: "success", node: FORM_MSG.noMoreSkills });
      },
      onError: (e) => setLine({ tone: "error", node: failure(e, FORM_MSG.unreachable) }),
    });
  };
  const picked = found
    ? found.list.filter((f) => f.pickable && ticked.has(f.name)).map((f) => f.name)
    : [];
  const onAdd = () => {
    setLine(undefined);
    add.mutate(picked, {
      onSuccess: () => {
        setFound(undefined);
        setLine({ tone: "success", node: `Added ${count(picked.length, "skill")}.` });
      },
      onError: (e) => setLine({ tone: "error", node: failure(e, FORM_MSG.unreachable) }),
    });
  };
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          aria-disabled={find.isPending}
          onClick={() => !find.isPending && onFind()}
        >
          {find.isPending ? (
            <Pending label="Finding skills…" since={find.submittedAt} />
          ) : (
            "Find more skills"
          )}
        </Button>
      </div>
      {found && found.list.length > 0 && (
        <>
          <AddSkillsResults
            result={{ found: found.list, source: "this source" }}
            seq={found.seq}
            stale={false}
            ticked={ticked}
            filter={filter}
            onFilter={setFilter}
            onTick={onTick}
            onToggle={onToggle}
          />
          <Button size="sm" disabled={picked.length === 0 || add.isPending} onClick={onAdd}>
            {add.isPending ? (
              <Pending label="Adding…" since={add.submittedAt} />
            ) : (
              `Add ${count(picked.length, "skill")} to this source`
            )}
          </Button>
        </>
      )}
      <Outcome line={line} />
    </div>
  );
}

/** A subject longer than this may need more than two lines, so it gets a Show all (CSS does the clamping). */
const SUBJECT_CLAMP_CHARS = 80;

/** A commit subject: two lines like a list row until Show all expands it in place. */
function ClampedSubject({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  const clamped = !all && text.length > SUBJECT_CLAMP_CHARS;
  return (
    <>
      <span className={clamped ? "line-clamp-2" : undefined}>
        <UntrustedProse text={text} />
      </span>
      {clamped && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="mt-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
        >
          Show all
        </button>
      )}
    </>
  );
}

/** The next source header after `id` in the page's list (else the one before it): where focus goes once it is gone. */
function neighbourHeader(id: string): string | null {
  const keys = [...document.querySelectorAll<HTMLElement>('[data-peek-key^="source:"]')]
    .filter((el) => el.hasAttribute("data-row"))
    .map((el) => el.dataset.peekKey ?? "");
  const i = keys.indexOf(`source:${id}`);
  return keys[i + 1] ?? keys[i - 1] ?? null;
}

/**
 * The Source peek (spec §10.3). The summary comes from the cached list row at once; the detail query refines it (its
 * GET can be slow when it must rebuild the update view, so that section has its own loading state). Check, Update,
 * Fetch again, Find and Remove are mutations started from handlers; this body is keyed by the peek's key, so every
 * result is dropped when the peek retargets.
 */
export function SourcePeekBody({
  id,
  back,
  onBack,
  onOpen,
  onRemoved,
}: {
  id: string;
  back: string | null;
  onBack(): void;
  onOpen(key: string): void;
  /** The source was removed: close the peek and put focus on `nextKey`'s header. */
  onRemoved(nextKey: string | null): void;
}) {
  const qc = useQueryClient();
  const select = selectSourceGroup(id);
  const { data: group } = useQuery({ ...libraryQueryOptions, select });
  const q = useQuery(sourceQueryOptions(id));
  const d = q.data;
  const summary = group?.source;
  const reasonId = useId();
  const [checkLine, setCheckLine] = useState<Line>();
  const [updateLine, setUpdateLine] = useState<Line>();
  const [removeLine, setRemoveLine] = useState<Line>();
  const refresh = () => qc.invalidateQueries({ queryKey: ["library"] });
  const check = useMutation({ mutationFn: () => checkSource(id), onSuccess: refresh });
  const update = useMutation({
    mutationFn: (commit: string) => updateSource(id, commit),
    onSuccess: refresh,
  });
  const fetchAgain = useMutation({ mutationFn: () => refetchSource(id), onSuccess: refresh });
  // The Undo toast is announced from the mutation's own `onSuccess`, which still runs if the peek retargets while the
  // DELETE is in flight (a `mutate(..., { onSuccess })` callback would not): the source is gone either way.
  const remove = useMutation({
    mutationFn: (_: { label: string; skills: number }) => removeSource(id),
    onSuccess: async ({ undoUntil }, { label, skills }) => {
      // The Undo window is the server's, read here and not by an effect (R-T1).
      const durationMs = Math.max(0, Date.parse(undoUntil) - Date.now());
      notify({
        text: `Removed ${label} and its ${count(skills, "skill")}.`,
        durationMs,
        undo: async () => {
          await undoRemove.current(undefined);
        },
      });
      await refresh();
    },
  });
  const restore = useMutation({ mutationFn: () => restoreSource(id), onSuccess: refresh });
  const undoRemove = useRef(restore.mutateAsync);
  undoRemove.current = restore.mutateAsync;

  const kind = d?.kind ?? summary?.kind;
  const label = d || summary ? sourceLabel(d ?? (summary as NonNullable<typeof summary>)) : "";
  const pin = d?.pin ?? summary?.pin ?? null;
  const skillCount = d?.skills.length ?? summary?.skillCount ?? 0;
  const users = d ? d.usedBy.templates + d.usedBy.agents : 0;
  const inUse = users > 0;
  const rows = group?.skills ?? [];
  const rowByName = new Map(rows.map((r) => [r.name, r]));
  const missing = rows.some((r) => r.state === "missing" && r.stateDetail === FORM_MSG.fetchAgain);
  const updateCommit = d?.updateCommit ?? null;
  const updateExpected = updateCommit !== null || (!d && summary?.update === true);

  const onCheck = () => {
    setCheckLine(undefined);
    check.mutate(undefined, {
      onSuccess: (r) =>
        setCheckLine(
          // A failed check is stored on the source: the state line below shows it once the detail refetches.
          r.updateCommit || r.checkError ? undefined : { tone: "success", node: "Up to date." },
        ),
      onError: (e) => setCheckLine({ tone: "error", node: failure(e, FORM_MSG.checkFailed) }),
    });
  };
  const onUpdate = () => {
    if (updateCommit === null) return;
    setUpdateLine(undefined);
    update.mutate(updateCommit, {
      onSuccess: () =>
        setUpdateLine({ tone: "success", node: `Updated to ${updateCommit.slice(0, 7)}.` }),
      onError: (e) => setUpdateLine({ tone: "error", node: failure(e, FORM_MSG.unreachable) }),
    });
  };
  const onRemove = () => {
    if (inUse || remove.isPending) return;
    setRemoveLine(undefined);
    const next = neighbourHeader(id);
    remove.mutate(
      { label, skills: skillCount },
      {
        onSuccess: () => onRemoved(next),
        onError: (e) => setRemoveLine({ tone: "error", node: failure(e, FORM_MSG.unreachable) }),
      },
    );
  };

  return (
    <>
      <SheetHeader className="items-center">
        {back !== null && <BackButton onBack={onBack} />}
        <SheetTitle className="font-mono text-sm font-normal">
          <MiddleTruncate text={visibleControls(label)} />
        </SheetTitle>
      </SheetHeader>
      <SheetBody className="space-y-4">
        {!d && q.isError && (
          <ErrorLine text={FORM_MSG.loadSkills} onRetry={() => void q.refetch()} />
        )}
        <Section
          title="Source"
          action={
            kind === "github" ? (
              <Button
                variant="ghost"
                size="xs"
                aria-disabled={check.isPending}
                onClick={() => !check.isPending && onCheck()}
              >
                {check.isPending ? (
                  <Pending label="Checking…" since={check.submittedAt} />
                ) : (
                  "Check for updates"
                )}
              </Button>
            ) : undefined
          }
        >
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[0.8125rem]">
            <dt className="text-muted-foreground">Kind</dt>
            <dd>{kind === "folder" ? "Folder" : kind === "github" ? "GitHub" : ""}</dd>
            {(d?.branch ?? summary?.branch) && (
              <>
                <dt className="text-muted-foreground">Branch</dt>
                <dd className="font-mono">
                  <UntrustedProse text={d?.branch ?? summary?.branch ?? ""} />
                </dd>
              </>
            )}
            <dt className="text-muted-foreground">Pin</dt>
            <dd>
              {kind === "folder" ? (
                "Live"
              ) : pin ? (
                <>
                  <PinButton sha={pin} />
                  <span className="mt-1 block font-mono text-xs break-all select-text">{pin}</span>
                </>
              ) : (
                pinLabel({ kind: kind ?? "github", pin })
              )}
            </dd>
            {d?.committedAt && (
              <>
                <dt className="text-muted-foreground">Date</dt>
                <dd>
                  <TimeAgo iso={d.committedAt} />
                </dd>
              </>
            )}
            {d?.subject && (
              <>
                <dt className="text-muted-foreground">Subject</dt>
                <dd>
                  <ClampedSubject text={d.subject} />
                </dd>
              </>
            )}
          </dl>
          {d?.checkError && (
            <p className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[0.8125rem]">
              <RowState state="check_failed" />
              <span className="min-w-0 [overflow-wrap:anywhere]">
                <UntrustedProse text={d.checkError} />
              </span>
            </p>
          )}
          <Outcome line={checkLine} />
          {/* Outside the Update section: a successful update clears the update, which unmounts that section. */}
          <Outcome line={updateLine} />
          {missing && (
            <p className="mt-2 flex items-center gap-2 text-[0.8125rem]">
              <RowState state="missing" />
              <Button
                variant="ghost"
                size="xs"
                aria-disabled={fetchAgain.isPending}
                onClick={() => !fetchAgain.isPending && fetchAgain.mutate()}
              >
                {fetchAgain.isPending ? (
                  <Pending label="Fetching…" since={fetchAgain.submittedAt} />
                ) : (
                  FORM_MSG.fetchAgain
                )}
              </Button>
            </p>
          )}
        </Section>

        {updateExpected && (
          <Section title="Update">
            <UpdateView
              from={pin}
              to={updateCommit}
              view={d?.update}
              loading={!d}
              action={
                <Button
                  size="sm"
                  aria-disabled={update.isPending || updateCommit === null}
                  onClick={() => !update.isPending && onUpdate()}
                >
                  {update.isPending ? (
                    <Pending label="Updating…" since={update.submittedAt} />
                  ) : (
                    `Update to ${(updateCommit ?? "").slice(0, 7)}`
                  )}
                </Button>
              }
            />
          </Section>
        )}

        <Section title="Skills">
          {d ? (
            <ul>
              {d.skills.map((n) => {
                const row = rowByName.get(n);
                return (
                  <li key={n} className="flex min-h-7 items-center gap-2 text-[0.8125rem]">
                    <button
                      type="button"
                      data-peek-key={skillKey(`source:${id}`, n)}
                      aria-haspopup="dialog"
                      onClick={() => onOpen(skillKey(`source:${id}`, n))}
                      className="min-w-0 truncate text-left font-mono underline-offset-2 hover:underline"
                    >
                      <UntrustedProse text={n} />
                    </button>
                    {row && row.state !== "ok" && <RowState state={row.state} />}
                  </li>
                );
              })}
            </ul>
          ) : (
            <SkeletonRows n={Math.min(skillCount, 6)} />
          )}
          {d && <FindMore id={id} />}
        </Section>
      </SheetBody>
      <SheetFooter className="flex-col items-stretch gap-2">
        {inUse && (
          <p id={reasonId} className="text-[0.8125rem] text-muted-foreground">
            {usedByText(d?.usedBy.templates ?? 0, d?.usedBy.agents ?? 0)}. Remove it from them
            first.
          </p>
        )}
        <Outcome line={removeLine} />
        <Button
          variant="ghost"
          aria-disabled={inUse || remove.isPending || !d}
          aria-describedby={inUse ? reasonId : undefined}
          onClick={onRemove}
          // The label carries the source's skill count and may wrap to two lines rather than outgrow a narrow sheet.
          className="h-auto min-h-8 max-w-full self-end py-1.5 text-right whitespace-normal text-destructive hover:text-destructive pointer-coarse:h-auto pointer-coarse:min-h-10"
        >
          {remove.isPending ? (
            <Pending label="Removing…" since={remove.submittedAt} />
          ) : (
            `Remove source (${count(skillCount, "skill")})`
          )}
        </Button>
      </SheetFooter>
    </>
  );
}
