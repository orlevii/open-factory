import {
  ApiError,
  checkBranchName,
  MSG,
  normalizeRepo,
  normalizeSubpath,
  type sourcePreviewSchema,
} from "@open-factory/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { z } from "zod";
import { Elapsed } from "@/components/elapsed";
import { FormField } from "@/components/form-field";
import { useOutcome } from "@/components/forms/form-outcome";
import { useFieldErrors } from "@/components/forms/use-field-errors";
import { checkHostPath, PathField } from "@/components/path-field";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { notify } from "@/components/ui/toaster";
import { FormFrame } from "@/features/settings/forms/form-frame";
import { fieldsOf } from "@/features/settings/forms/shared";
import { clearDraft, clearDraftIf, peekDraft, useSheetDraft } from "@/features/sheets/drafts";
import type { BodyProps } from "@/features/sheets/sheet-bodies";
import { getSheetState } from "@/features/sheets/sheet-store";
import { FORM_MSG } from "@/lib/form-messages";
import {
  addSkillSource,
  previewSkillSource,
  removeSource,
  type SkillSourceAddBody,
  type SkillSourcePreviewBody,
} from "@/lib/library";
import { AddSkillsResults, type FindResult } from "./add-skills-results";
import { count, sourceLabel } from "./format";

type Mode = "folder" | "github";
type Values = { mode: Mode; path: string; repo: string; subpath: string; branch: string };
type Field = "path" | "repo" | "subpath" | "branch";
const FIELDS: readonly Field[] = ["path", "repo", "subpath", "branch"];
const FOLDER_FIELDS: readonly Field[] = ["path"];
const GITHUB_FIELDS: readonly Field[] = ["repo", "subpath", "branch"];

const BLANK: Values = { mode: "folder", path: "", repo: "", subpath: "", branch: "" };
const MODES = [
  { value: "folder", label: "Folder" },
  { value: "github", label: "GitHub" },
] as const;

const PICK_ONE = FORM_MSG.pickAtLeastOne;
/** Inert primary after Find lands (spec §10.4). */
const INERT_MS = 300;

type Preview = z.infer<typeof sourcePreviewSchema>;

/** The source the form names now. A result is stale when this differs from the one it was found for. */
const sourceKey = (v: Values) =>
  v.mode === "folder"
    ? `folder\0${v.path.trim()}`
    : `github\0${v.repo.trim()}\0${v.subpath.trim()}\0${v.branch.trim()}`;

const previewBody = (v: Values): SkillSourcePreviewBody =>
  v.mode === "folder"
    ? { kind: "folder", path: v.path.trim() }
    : {
        kind: "github",
        repo: v.repo.trim(),
        ...(v.subpath.trim() ? { subpath: v.subpath.trim() } : {}),
        ...(v.branch.trim() ? { branch: v.branch.trim() } : {}),
      };

type Found = { key: string; seq: number; view: FindResult; previewId: string | undefined };
type FindVars = { body: SkillSourcePreviewBody; signal: AbortSignal };
type AddVars = { body: SkillSourceAddBody; snapshot: unknown };

/** The label of a source, for the zero-found line: the repo as typed, normalised when it parses. */
function labelOf(v: Values): string {
  if (v.mode === "folder") return v.path.trim();
  const r = normalizeRepo(v.repo.trim());
  return sourceLabel({
    kind: "github",
    path: null,
    repo: r ? `${r.owner}/${r.repo}` : v.repo.trim(),
    subpath: v.subpath.trim() || null,
  });
}

/**
 * Add skills (spec §10.4): Find a folder or GitHub source, pick what to add, Add. Find and Add are mutations from
 * handlers with their results in component state (R-Q1). One `AbortController` lives in a ref: a new Find aborts the
 * previous one in its click handler, Close aborts in its handler, and the unmount cleanup, this sheet's only effect, aborts
 * as well (R-L3). The 300 ms inert primary starts in Find's `onSuccess` (R-T1). Ticks are a `Set` updated functionally;
 * the filtered rows, the toggle and the stale flag are derived during render (R-F1).
 */
export default function AddSkillsSheet({ sheetId, close }: BodyProps<{ kind: "add-skills" }>) {
  const qc = useQueryClient();
  const draft = useSheetDraft<Values>("add-skills", () => BLANK);
  const [values, setValues] = useState<Values>(draft.start);
  const [restored, setRestored] = useState(draft.restored);
  const [found, setFound] = useState<Found>();
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [inert, setInert] = useState(false);
  const o = useOutcome();
  const formRef = useRef<HTMLFormElement>(null);
  const ctl = useRef<AbortController | null>(null);
  const inertTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      ctl.current?.abort();
      clearTimeout(inertTimer.current);
    },
    [],
  );

  const stillOpen = () => getSheetState().parent?.id === sheetId;
  const github = values.mode === "github";

  const f = useFieldErrors({
    form: formRef,
    fields: FIELDS,
    checks: {
      path: () => checkHostPath(values.path),
      repo: () => {
        const t = values.repo.trim();
        if (t === "") return MSG.repoFormat;
        return normalizeRepo(t) === null ? MSG.repoFormat : undefined;
      },
      subpath: () =>
        values.subpath.trim() === "" || normalizeSubpath(values.subpath.trim()) !== null
          ? undefined
          : MSG.subpathNotFolder,
      branch: () =>
        values.branch.trim() === "" || checkBranchName(values.branch.trim())
          ? undefined
          : MSG.branchMissing,
    },
  });

  const find = useMutation({
    mutationFn: ({ body, signal }: FindVars) => previewSkillSource(body, signal),
  });
  const add = useMutation({
    mutationFn: ({ body }: AddVars) => addSkillSource(body),
    // Runs even when the sheet was closed while a GitHub add re-fetched: the source then shows as a pending header.
    onSuccess: (source, { body, snapshot }) => {
      void qc.invalidateQueries({ queryKey: ["library"] });
      if (stillOpen()) {
        clearDraft("add-skills");
        close();
      } else clearDraftIf("add-skills", snapshot);
      if (source.state === "adding") return;
      notify({
        text: `Added ${count(body.skills.length, "skill")}.`,
        undo: async () => {
          await removeSource(source.id);
          await qc.invalidateQueries({ queryKey: ["library"] });
        },
      });
    },
    onError: (err) => {
      if (stillOpen()) return;
      notify({ text: err instanceof ApiError ? err.message : FORM_MSG.unreachable });
    },
  });

  const key = sourceKey(values);
  const fresh = found !== undefined && found.key === key;
  const picked = found
    ? found.view.found.filter((x) => x.pickable && ticked.has(x.name)).map((x) => x.name)
    : [];
  const noPick = fresh && picked.length === 0;
  const pending = find.isPending || add.isPending;

  const change = (patch: Partial<Values>) => {
    const next = { ...values, ...patch };
    setValues(next);
    draft.save(next);
  };

  const onFind = () => {
    if (!f.submit(github ? GITHUB_FIELDS : FOLDER_FIELDS)) return;
    o.clear();
    // A newer Find supersedes the running one, here in the handler that starts it.
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    const forKey = key;
    const prev = found?.view.found.map((x) => x.name);
    const view = values;
    find.mutate(
      { body: previewBody(view), signal: c.signal },
      {
        onSuccess: (r: Preview) => {
          if (c.signal.aborted) return;
          // Old ticks stay for names still found; names new to this Find start ticked when pickable.
          const before = new Set(prev);
          setTicked((old) => {
            const next = new Set<string>();
            for (const x of r.found)
              if (x.pickable && (old.has(x.name) || !before.has(x.name))) next.add(x.name);
            return next;
          });
          setFound((p) => ({
            key: forKey,
            seq: (p?.seq ?? 0) + 1,
            previewId: r.previewId,
            view: {
              found: r.found,
              source: labelOf(view),
              commit: r.commit,
              branch: r.branch,
              committedAt: r.committedAt,
              subject: r.subject,
            },
          }));
          setFilter("");
          setInert(true);
          clearTimeout(inertTimer.current);
          inertTimer.current = setTimeout(() => setInert(false), INERT_MS);
        },
        onError: (err) => {
          if (c.signal.aborted) return;
          if (!f.server(fieldsOf(err)))
            o.fail(err instanceof ApiError ? err.message : FORM_MSG.unreachable);
        },
      },
    );
  };

  const onAdd = () => {
    if (!found || !fresh || picked.length === 0) return;
    o.clear();
    const body: SkillSourceAddBody =
      values.mode === "folder"
        ? { kind: "folder", path: values.path.trim(), skills: picked }
        : { kind: "github", previewId: found.previewId ?? "", skills: picked };
    add.mutate(
      { body, snapshot: peekDraft("add-skills") },
      {
        onError: (err) => {
          if (!f.server(fieldsOf(err)))
            o.fail(err instanceof ApiError ? err.message : FORM_MSG.unreachable);
        },
      },
    );
  };

  const onTick = useCallback((name: string, on: boolean) => {
    setTicked((s) => {
      const next = new Set(s);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });
  }, []);
  const onToggle = useCallback((names: string[], on: boolean) => {
    setTicked((s) => {
      const next = new Set(s);
      for (const n of names) {
        if (on) next.add(n);
        else next.delete(n);
      }
      return next;
    });
  }, []);

  const onCancel = () => {
    ctl.current?.abort();
    close();
  };

  const discard = () => {
    draft.clear();
    setValues(BLANK);
    setRestored(false);
    f.reset();
  };

  const outcome =
    noPick && found.view.found.some((x) => x.pickable)
      ? { ...o.outcome, notice: PICK_ONE }
      : o.outcome;

  return (
    <FormFrame
      frame="sheet"
      label="Add skills"
      ref={formRef}
      onSubmit={fresh ? onAdd : onFind}
      onCancel={onCancel}
      submitLabel={fresh ? `Add ${count(picked.length, "skill")}` : "Find skills"}
      pendingLabel={add.isPending ? "Adding…" : "Finding…"}
      pendingExtra={
        pending ? (
          <span aria-hidden="true">
            <Elapsed
              since={new Date(add.isPending ? add.submittedAt : find.submittedAt).toISOString()}
              hideUnderMs={10_000}
            />
          </span>
        ) : null
      }
      submitClassName="min-w-36 tabular-nums"
      submitDisabled={inert || noPick}
      pending={pending}
      outcome={outcome}
      left={
        restored ? (
          <span className="inline-flex items-center gap-2">
            Draft restored <span>·</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              inForm
              className="-ml-1 px-1"
              data-skip-validate
              onClick={discard}
            >
              Discard
            </Button>
          </span>
        ) : undefined
      }
    >
      <SegmentedControl
        legend="Source"
        legendVisible
        name="skills-source"
        value={values.mode}
        options={MODES}
        onChange={(mode) => {
          change({ mode });
          f.reset();
        }}
      />
      {github ? (
        <>
          <FormField
            name="skills-repo"
            label="Repository"
            help="owner/repo or a github.com URL. Private repos use this host's git sign-in."
            error={f.errors.repo}
            value={values.repo}
            onChange={(e) => {
              change({ repo: e.target.value });
              f.change("repo");
            }}
            onBlur={(e) => f.blur("repo", e)}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            className="font-mono"
          />
          <FormField
            name="skills-subpath"
            label="Path (optional)"
            help="The folder inside the repo. Empty means the whole repo."
            error={f.errors.subpath}
            value={values.subpath}
            onChange={(e) => {
              change({ subpath: e.target.value });
              f.change("subpath");
            }}
            onBlur={(e) => f.blur("subpath", e)}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            className="font-mono"
          />
          <FormField
            name="skills-branch"
            label="Branch (optional)"
            help="Empty means the default branch. Submodules and LFS files aren't fetched."
            error={f.errors.branch}
            value={values.branch}
            onChange={(e) => {
              change({ branch: e.target.value });
              f.change("branch");
            }}
            onBlur={(e) => f.blur("branch", e)}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            className="font-mono"
          />
        </>
      ) : (
        <PathField
          name="skills-path"
          label="Path"
          help="A skill folder, or a folder of skills, on the factory's machine."
          error={f.errors.path}
          value={values.path}
          onChange={(e) => {
            change({ path: e.target.value });
            f.change("path");
          }}
          onBlur={(e) => f.blur("path", e)}
        />
      )}
      {found && (
        <AddSkillsResults
          result={found.view}
          seq={found.seq}
          stale={!fresh}
          ticked={ticked}
          filter={filter}
          onFilter={setFilter}
          onTick={onTick}
          onToggle={onToggle}
        />
      )}
    </FormFrame>
  );
}
