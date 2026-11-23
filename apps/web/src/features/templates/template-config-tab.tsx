import {
  ApiError,
  type ConfigDoc,
  type ConfigHashes,
  canonicalJson,
  emptyDoc,
  type TemplateConfigResponse,
  type TemplateFile,
  type TemplateIssue,
  templateIssueSchema,
} from "@open-factory/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { memo, type RefObject, useCallback, useId, useState } from "react";
import { z } from "zod";
import { ErrorLine } from "@/components/error-line";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { putTemplateConfig, templateConfigQueryOptions } from "@/features/config/api";
import { ConfigForm, type RawTarget } from "@/features/config/config-form";
import {
  CONFIG_FORM_MSG,
  CONFIG_PAGE_MSG,
  fileHasEdits,
  openFileLabel,
  TEMPLATE_TAB_COPY,
  templateUsageLine,
} from "@/features/config/messages";
import { PageFooter } from "@/features/config/page-footer";
import {
  clearTransient,
  NO_PAGE_OUTCOME,
  toFormOutcome,
  usePageOutcome,
} from "@/features/config/page-outcome";
import type { useConfigDraft } from "@/features/config/use-config-draft";

export type ConfigDraft = ReturnType<typeof useConfigDraft<unknown>>;

/** The draft hook's version for a template's config: its three file hashes, canonical, so a save sends them back. */
export const hashesVersion = (h: ConfigHashes) => canonicalJson(h);
/** A broken template has no doc: the form shows an empty one, read-only. */
export const EMPTY_DOC: ConfigDoc = emptyDoc();

const issuesBody = z.object({ issues: z.array(templateIssueSchema) });
/** Where "Show in Raw JSON" goes for a doc path with no file of its own: the part's file. */
const FILE_OF_PART: Record<string, TemplateFile> = {
  template: "template.yaml",
  settings: "settings.json",
  mcp: "mcp.json",
};

/**
 * The template editor's Configuration tab (spec §12.5): `ConfigForm mode="template"` over the editor-owned draft, the
 * usage line, the locks of R2 (one draft per file), and the page footer. Memoized: a keystroke in a file tab doesn't
 * re-render it. The editor owns the query and the draft; `draft` is read through a ref so the props stay stable.
 */
export const TemplateConfigTab = memo(function TemplateConfigTab({
  name,
  data,
  loadError,
  onRetry,
  value,
  dirty,
  drift,
  conflicts,
  baseVersion,
  draft,
  lockedBy,
  onJump,
  onFilesChanged,
}: {
  name: string;
  data: TemplateConfigResponse | undefined;
  loadError: boolean;
  onRetry(): void;
  value: unknown;
  dirty: boolean;
  drift: boolean;
  conflicts: readonly string[];
  baseVersion: string;
  /** The latest committed draft hook (useLatest): its actions, and the draft as a resumed handler sees it. */
  draft: RefObject<ConfigDraft>;
  /** The config file whose tab holds unsaved edits: the form is read-only until it is saved or discarded. */
  lockedBy: TemplateFile | undefined;
  onJump(file: TemplateIssue["file"], line: number): void;
  /** The files on disk changed under the file tabs (a save or a reload here): they read them again. */
  onFilesChanged(): Promise<void>;
}) {
  const qc = useQueryClient();
  const save = useMutation({
    mutationKey: ["template-config", name, "save"],
    mutationFn: (body: Parameters<typeof putTemplateConfig>[1]) => putTemplateConfig(name, body),
  });
  const { outcome, outcomeKey, setOutcome } = usePageOutcome();
  const [issuesOverride, setIssuesOverride] = useState<TemplateIssue[] | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const saveId = useId();

  const onChange = useCallback(
    (update: (prev: unknown) => unknown) => {
      setOutcome(clearTransient);
      draft.current.setDraft(update);
    },
    [draft, setOutcome],
  );
  const onShowRaw = useCallback(
    (at: RawTarget) => {
      const file = at.file ?? FILE_OF_PART[at.path?.split(".")[0] ?? ""];
      if (file) onJump(file, at.line ?? 1);
    },
    [onJump],
  );

  if (!data)
    return loadError ? (
      <ErrorLine text={CONFIG_PAGE_MSG.couldntLoad} onRetry={onRetry} />
    ) : (
      <Skeleton className="h-40" />
    );

  const valid = data.doc !== null;
  const issues = issuesOverride ?? data.issues;
  const usage = templateUsageLine(data.agents.live, data.agents.cantStart, valid);

  function onDiscard() {
    draft.current.discard();
    setIssuesOverride(null);
    setOutcome({ kind: "discarded", text: CONFIG_PAGE_MSG.discarded });
  }
  function onUndo() {
    draft.current.undoDiscard();
    setOutcome(NO_PAGE_OUTCOME);
  }

  async function onSave() {
    if (save.isPending || lockedBy || !valid) return;
    if (editorOpen) {
      // The open MCP editor's edits aren't in the draft until its Done: nothing is sent (C3 review I2).
      setOutcome({ kind: "error", text: CONFIG_FORM_MSG.finishServer });
      document.getElementById("field-mcp-name")?.focus();
      return;
    }
    if (!dirty) return;
    const sent = draft.current.draft as ConfigDoc;
    setOutcome(NO_PAGE_OUTCOME);
    let r: Awaited<ReturnType<typeof putTemplateConfig>>;
    try {
      r = await save.mutateAsync({
        doc: sent,
        baseHashes: JSON.parse(baseVersion) as ConfigHashes,
      });
    } catch (e) {
      if (e instanceof ApiError && e.code === "changed_on_disk")
        return setOutcome({ kind: "conflict" });
      const body = e instanceof ApiError ? issuesBody.safeParse(e.body) : null;
      if (body?.success) {
        setIssuesOverride(body.data.issues);
        return setOutcome({ kind: "error", text: CONFIG_PAGE_MSG.hasErrors });
      }
      return setOutcome({ kind: "error", text: CONFIG_PAGE_MSG.couldntSave });
    }
    const key = templateConfigQueryOptions(name).queryKey;
    qc.setQueryData(key, (old) =>
      old ? { ...old, doc: sent, hashes: r.hashes, issues: r.issues } : old,
    );
    const d = draft.current;
    if (d.draft === sent) d.reset();
    else d.rebase({ value: sent, version: hashesVersion(r.hashes) });
    setIssuesOverride(null);
    setOutcome({ kind: "saved", text: CONFIG_PAGE_MSG.saved });
    // What the server wrote (only the keys the form owns), and the file tabs' texts and hashes.
    void qc.invalidateQueries({ queryKey: key, exact: true });
    void qc.invalidateQueries({ queryKey: ["templates"], exact: true });
    // The save stands even if the file tabs can't re-read the files now: a later file save's conflict line recovers.
    await onFilesChanged().catch(() => {});
  }

  /** changed_on_disk → Reload: the files as they are now, my edits re-applied over them. Still unsaved. */
  async function onReload() {
    try {
      const fresh = await qc.fetchQuery(templateConfigQueryOptions(name));
      draft.current.rebase({ value: fresh.doc ?? EMPTY_DOC, version: hashesVersion(fresh.hashes) });
      setIssuesOverride(null);
      setOutcome(NO_PAGE_OUTCOME);
      document.getElementById(saveId)?.focus();
    } catch {
      return setOutcome({ kind: "error", text: CONFIG_PAGE_MSG.couldntReload });
    }
    // The rebase stands; the file tabs catch up when they can.
    await onFilesChanged().catch(() => {});
  }

  const { outcome: footerOutcome, shown } = toFormOutcome(outcome, outcomeKey, {
    drift,
    notice: lockedBy ? fileHasEdits(lockedBy) : undefined,
    onUndo,
    onReload: () => void onReload(),
  });

  return (
    <div className="grid max-w-[44rem] min-w-0 grid-cols-[minmax(0,1fr)] gap-8">
      {usage || lockedBy || !valid ? (
        <div className="grid gap-3 text-sm leading-5">
          {usage ? <p className="text-muted-foreground">{usage}</p> : null}
          {!valid ? <p>{TEMPLATE_TAB_COPY.broken}</p> : null}
          {/* The sentence is the footer's notice (it describes the held Save); here, only the way to the file. */}
          {lockedBy ? (
            <div>
              <Button type="button" variant="ghost" size="xs" onClick={() => onJump(lockedBy, 1)}>
                {openFileLabel(lockedBy)}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      <ConfigForm
        mode="template"
        value={value}
        onChange={onChange}
        readOnly={!valid || lockedBy !== undefined}
        issues={issues}
        conflicts={conflicts}
        onShowRaw={onShowRaw}
        localSkills={data.localSkills}
        onEditorOpenChange={setEditorOpen}
      />
      <PageFooter
        outcome={footerOutcome}
        sticky={dirty || shown}
        pending={save.isPending}
        canSave={dirty && valid && !lockedBy}
        canDiscard={dirty}
        onSave={() => void onSave()}
        onDiscard={onDiscard}
        saveId={saveId}
      />
    </div>
  );
});
