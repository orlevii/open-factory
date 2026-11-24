import {
  ApiError,
  checkGitUrl,
  MSG,
  type marketplacePreviewSchema,
  normalizeRepo,
} from "@open-factory/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { z } from "zod";
import { Elapsed } from "@/components/elapsed";
import { FormField } from "@/components/form-field";
import { useOutcome } from "@/components/forms/form-outcome";
import { useFieldErrors } from "@/components/forms/use-field-errors";
import { checkHostPath, PathField } from "@/components/path-field";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { notify } from "@/components/ui/toaster";
import { UntrustedProse, visibleControls } from "@/components/untrusted-text";
import { FormFrame } from "@/features/settings/forms/form-frame";
import { fieldsOf } from "@/features/settings/forms/shared";
import { TimeAgo } from "@/features/settings/shared";
import { clearDraft, clearDraftIf, peekDraft, useSheetDraft } from "@/features/sheets/drafts";
import type { BodyProps } from "@/features/sheets/sheet-bodies";
import { getSheetState } from "@/features/sheets/sheet-store";
import { FORM_MSG } from "@/lib/form-messages";
import {
  addMarketplace,
  type MarketplacePreviewBody,
  previewMarketplace,
  removeMarketplace,
} from "@/lib/library";
import { versionLabel } from "./format";
import { RowState } from "./row-state";

type Mode = "github" | "git" | "directory";
type Values = { mode: Mode; repo: string; url: string; path: string };
type Field = "repo" | "url" | "path";
const FIELDS: readonly Field[] = ["repo", "url", "path"];
const FIELD_OF: Record<Mode, Field> = { github: "repo", git: "url", directory: "path" };

const BLANK: Values = { mode: "github", repo: "", url: "", path: "" };
const MODES = [
  { value: "github", label: "GitHub" },
  { value: "git", label: "Git URL" },
  { value: "directory", label: "Folder" },
] as const;

/** Inert primary after Find lands (spec §10.4). */
const INERT_MS = 300;

type Preview = z.infer<typeof marketplacePreviewSchema>;

/** The source the form names now. A result is stale when this differs from the one it was found for. */
const sourceKey = (v: Values) =>
  v.mode === "github"
    ? `github\0${v.repo.trim()}`
    : v.mode === "git"
      ? `git\0${v.url.trim()}`
      : `directory\0${v.path.trim()}`;

const previewBody = (v: Values): MarketplacePreviewBody =>
  v.mode === "github"
    ? { kind: "github", repo: v.repo.trim() }
    : v.mode === "git"
      ? { kind: "git", url: v.url.trim() }
      : { kind: "directory", path: v.path.trim() };

type Found = { key: string; seq: number; view: Preview };

/** The results label moves focus here when it mounts (a new Find remounts it by key): the focus is the announcement. */
function focusAndReveal(el: HTMLElement | null) {
  if (!el) return;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: "nearest" });
}

/** A catalog entry that can't be pinned or used: "Can't use" for a refused source, "Can't be pinned" otherwise. */
const isRefused = (p: Preview["plugins"][number]) =>
  !p.pinnable && p.refusedReason !== undefined && !p.refusedReason.startsWith("Can't be pinned");

function PreviewPlugin({ p }: { p: Preview["plugins"][number] }) {
  return (
    <li className="py-1.5 text-[0.8125rem]">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <span className="font-mono [overflow-wrap:anywhere]">
          <UntrustedProse text={p.name} />
        </span>
        {p.version && <span className="text-muted-foreground">{versionLabel(p.version)}</span>}
        {!p.pinnable && <RowState state={isRefused(p) ? "refused" : "cant_pin"} />}
      </div>
      {p.description && (
        <span className="line-clamp-2 block text-muted-foreground">
          <UntrustedProse text={p.description} />
        </span>
      )}
      {isRefused(p) && p.refusedReason && (
        <span className="block text-muted-foreground">
          <UntrustedProse text={p.refusedReason} />
        </span>
      )}
    </li>
  );
}

/** Step 1's result: what was found and its plugins. Everything is derived from props during render. */
function MarketplacePreviewView({ found, stale }: { found: Found; stale: boolean }) {
  const v = found.view;
  const commit = v.commit?.slice(0, 7);
  return (
    <section className="space-y-1.5" aria-label="Found marketplace">
      <p
        key={found.seq}
        ref={focusAndReveal}
        tabIndex={-1}
        className="text-[0.8125rem] font-medium outline-none" // ui-contract:allow programmatic focus target, not interactive
      >
        {commit ? (
          <>
            Found {visibleControls(v.name)} at <span className="font-mono">{commit}</span>
            {v.branch && <> · {visibleControls(v.branch)}</>}
            {v.subject && (
              <>
                {" · "}
                <UntrustedProse text={v.subject} />
              </>
            )}
          </>
        ) : (
          <>Found {visibleControls(v.name)}, a local folder read live</>
        )}
      </p>
      <p className="text-[0.8125rem] text-muted-foreground">
        {stale ? (
          FORM_MSG.marketplaceChanged
        ) : (
          <>
            {v.committedAt && (
              <>
                <TimeAgo iso={v.committedAt} />
                {" · "}
              </>
            )}
            {v.plugins.length === 1 ? "1 plugin" : `${v.plugins.length} plugins`}
          </>
        )}
      </p>
      {!stale && !v.commitPinnable && v.commit !== null && (
        <p className="text-[0.8125rem]">
          {visibleControls(v.name)} can only be used at Latest: Claude Code refuses a commit pin for
          it.
        </p>
      )}
      {v.plugins.length === 0 ? (
        <p className="text-[0.8125rem] text-muted-foreground">This marketplace lists no plugins.</p>
      ) : (
        <ul className="divide-y divide-border">
          {v.plugins.map((p) => (
            <PreviewPlugin key={p.name} p={p} />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Add marketplace (spec §10.4): Find a GitHub repo, git URL or folder, then Add. Find and Add are mutations from
 * handlers with their results in component state (R-Q1), laid out as Add skills: one `AbortController` in a ref aborts a
 * superseded Find, Close and unmount; the 300 ms inert primary starts in Find's `onSuccess` (R-T1); the stale flag is
 * derived during render (R-F1). A 201 closes the sheet with an Undo toast; a 202 (the preview was swept and it
 * re-fetches) closes it at once and the Marketplaces list shows the pending row, whose outcome arrives as a toast.
 */
export default function AddMarketplaceSheet({
  sheetId,
  close,
}: BodyProps<{ kind: "add-marketplace" }>) {
  const qc = useQueryClient();
  const draft = useSheetDraft<Values>("add-marketplace", () => BLANK);
  const [values, setValues] = useState<Values>(draft.start);
  const [restored, setRestored] = useState(draft.restored);
  const [found, setFound] = useState<Found>();
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

  const f = useFieldErrors({
    form: formRef,
    fields: FIELDS,
    checks: {
      repo: () => (normalizeRepo(values.repo.trim()) === null ? MSG.repoFormat : undefined),
      url: () => (checkGitUrl(values.url.trim()) ? undefined : FORM_MSG.gitUrl),
      path: () => checkHostPath(values.path),
    },
  });

  const find = useMutation({
    mutationFn: ({ body, signal }: { body: MarketplacePreviewBody; signal: AbortSignal }) =>
      previewMarketplace(body, signal),
  });
  const add = useMutation({
    mutationFn: ({ previewId }: { previewId: string; name: string; snapshot: unknown }) =>
      addMarketplace(previewId),
    // Runs even when the sheet was closed while it re-fetched: the list then shows the pending row.
    onSuccess: (m, { snapshot }) => {
      void qc.invalidateQueries({ queryKey: ["library"] });
      if (stillOpen()) {
        clearDraft("add-marketplace");
        close();
      } else clearDraftIf("add-marketplace", snapshot);
      if (m.state === "adding") return;
      notify({
        text: m.commit ? `Added ${m.name} at ${m.commit.slice(0, 7)}.` : `Added ${m.name}.`,
        undo: async () => {
          await removeMarketplace(m.name);
          await qc.invalidateQueries({ queryKey: ["library"] });
        },
      });
    },
    onError: (_err, { name }) => {
      if (!stillOpen()) notify({ text: `Couldn't add ${name}.` });
    },
  });

  const key = sourceKey(values);
  const fresh = found !== undefined && found.key === key;
  const pending = find.isPending || add.isPending;

  const change = (patch: Partial<Values>) => {
    const next = { ...values, ...patch };
    setValues(next);
    draft.save(next);
  };

  const onFind = () => {
    if (!f.submit([FIELD_OF[values.mode]])) return;
    o.clear();
    // A newer Find supersedes the running one, here in the handler that starts it (R-L3).
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    const forKey = key;
    find.mutate(
      { body: previewBody(values), signal: c.signal },
      {
        onSuccess: (r) => {
          setFound((p) => ({ key: forKey, seq: (p?.seq ?? 0) + 1, view: r }));
          setInert(true);
          clearTimeout(inertTimer.current);
          inertTimer.current = setTimeout(() => setInert(false), INERT_MS);
        },
        onError: (err) => {
          if (!f.server(fieldsOf(err)))
            o.fail(err instanceof ApiError ? err.message : FORM_MSG.unreachable);
        },
      },
    );
  };

  const onAdd = () => {
    // The frame blocks a submit during the inert window, so only a fresh result reaches here.
    if (!found || !fresh) return;
    o.clear();
    add.mutate(
      {
        previewId: found.view.previewId,
        name: found.view.name,
        snapshot: peekDraft("add-marketplace"),
      },
      {
        onError: (err) => {
          if (!f.server(fieldsOf(err)))
            o.fail(err instanceof ApiError ? err.message : FORM_MSG.unreachable);
        },
      },
    );
  };

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

  const m = values.mode;
  return (
    <FormFrame
      frame="sheet"
      label="Add marketplace"
      ref={formRef}
      onSubmit={fresh ? onAdd : onFind}
      onCancel={onCancel}
      submitLabel={fresh ? "Add marketplace" : "Find marketplace"}
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
      submitClassName="min-w-40 tabular-nums"
      submitDisabled={inert}
      pending={pending}
      outcome={o.outcome}
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
        name="marketplace-source"
        value={m}
        options={MODES}
        onChange={(mode) => {
          change({ mode });
          f.reset();
        }}
      />
      {m === "github" ? (
        <FormField
          name="marketplace-repo"
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
      ) : m === "git" ? (
        <FormField
          name="marketplace-url"
          label="Repository URL"
          help="An https:// URL with no sign-in, query or #. Private repos use this host's git sign-in."
          error={f.errors.url}
          value={values.url}
          onChange={(e) => {
            change({ url: e.target.value });
            f.change("url");
          }}
          onBlur={(e) => f.blur("url", e)}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          className="font-mono"
        />
      ) : (
        <PathField
          name="marketplace-path"
          label="Path"
          help="A marketplace folder on the factory's machine. It is read live."
          error={f.errors.path}
          value={values.path}
          onChange={(e) => {
            change({ path: e.target.value });
            f.change("path");
          }}
          onBlur={(e) => f.blur("path", e)}
        />
      )}
      {found && <MarketplacePreviewView found={found} stale={!fresh} />}
    </FormFrame>
  );
}
