import type { EditorState } from "@codemirror/state";
import {
  ApiError,
  TEMPLATE_FILES,
  type TemplateDetail,
  type TemplateFile,
  type TemplateIssue,
} from "@open-factory/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useBlocker, useNavigate } from "@tanstack/react-router";
import { Trash2, TriangleAlert, UserPlus } from "lucide-react";
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { InlineOutcome } from "@/components/inline-outcome";
import { MarkdownEditor } from "@/components/markdown/markdown-editor";
import { MiddleTruncate } from "@/components/middle-truncate";
import { HeaderSlug, PageBody, PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { factorySettingsQueryOptions } from "@/features/settings/api";
import { sheetIntent } from "@/features/sheets/sheet-bodies";
import { openSheet } from "@/features/sheets/sheet-store";
import {
  buildImage,
  deletedState,
  deleteTemplate,
  saveTemplateFile,
  templateQueryOptions,
  validateTemplateFile,
} from "./api";
import type { CodeEditorHandle } from "./code-editor";
import type { Diag, Lang } from "./code-editor-setup";
import {
  CodeSurface,
  type CodeSurfaceProps,
  focusTextareaLine,
  isEditorSettled,
} from "./code-surface";
import { ImageStatusLabel } from "./image-status";
import { IssueIcon, IssueList, sortIssues } from "./issue-list";

type FileState = {
  content: string;
  /** What is on disk as far as we know: the dirty comparison and Discard target. */
  saved: string;
  baseHash: string | null;
  /** False for an optional file that doesn't exist yet and hasn't been started. */
  started: boolean;
  conflict?: { currentHash: string | null };
};
type Outcome =
  | { tone: "success" | "error"; text: string }
  | { tone: "pending"; text: string; kind: "checking" | "saving" | "reloading" };

const OPTIONAL_SEED: Partial<Record<TemplateFile, string>> = {
  "settings.json": "{}\n",
  "mcp.json": '{\n  "mcpServers": {}\n}\n',
};
const isOptional = (f: TemplateFile) => f in OPTIONAL_SEED;

const initial = (t: TemplateDetail): Record<TemplateFile, FileState> =>
  Object.fromEntries(
    TEMPLATE_FILES.map((f) => {
      const s = t.files.find((x) => x.file === f);
      const content = s?.content ?? "";
      return [
        f,
        {
          content,
          saved: content,
          baseHash: s?.hash ?? null,
          started: !(isOptional(f) && s?.content == null),
        },
      ];
    }),
  ) as Record<TemplateFile, FileState>;

const isDirty = (s: FileState) => s.started && (s.content !== s.saved || s.baseHash === null);

/** A save or reload in flight blocks another; a blur validate never does (Save supersedes it). */
const isBusy = (o?: Outcome) => o?.tone === "pending" && o.kind !== "checking";

const goneMessage = "This template no longer exists on disk.";

const LANGUAGE: Record<TemplateFile, Lang> = {
  "template.yaml": "yaml",
  "AGENTS.md": "markdown",
  "settings.json": "json",
  "mcp.json": "json",
};

/** Where the user was in the textarea fallback when the editor replaced it. */
type Carry = { anchor: number; head: number; scrollTop: number; focus: boolean };

/** The tab's file name alone (without "(unsaved)"): the editor's accessible name. */
const labelId = (f: TemplateFile) => `tab-label-${f}`;
const focusEditor = (f: TemplateFile) => document.getElementById(`editor-${f}`)?.focus();

export function TemplateEditor({ template }: { template: TemplateDetail }) {
  const name = template.name;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [files, setFiles] = useState(() => initial(template));
  const [issues, setIssues] = useState<TemplateIssue[]>(template.issues);
  const [tab, setTab] = useState<TemplateFile>("template.yaml");
  const [mdView, setMdView] = useState<"write" | "preview">("write");
  const [outcomes, setOutcomes] = useState<Partial<Record<TemplateFile, Outcome>>>({});
  const [gone, setGone] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [jumpN, setJumpN] = useState(0);
  // The live factory default, for the warm_window_minutes hint (Settings → Factory changes it).
  const warmDefault = useQuery(factorySettingsQueryOptions).data?.defaultWarmWindowMinutes;
  const refs = useRef<Partial<Record<TemplateFile, HTMLTextAreaElement | null>>>({});
  const editors = useRef<Partial<Record<TemplateFile, CodeEditorHandle | null>>>({});
  // Each file's EditorState (doc, selection, undo history), so a remounted tab gets it back.
  // Keyed `${name}:${file}`; dropped with this component.
  const states = useState(() => new Map<string, EditorState>())[0];
  const carried = useRef<Partial<Record<TemplateFile, Carry>>>({});
  // The last content each file was validated or saved as, so blur only asks when it changed.
  const checked = useRef<Partial<Record<TemplateFile, string>>>({});
  // Responses replace the whole issue list; only the newest request may do so.
  const seq = useRef(0);
  const leaving = useRef(false);
  const headingId = useId();
  // Stable, so it runs only when a conflict block mounts: keyboard users land on its Reload.
  const focusOnMount = useCallback((el: HTMLButtonElement | null) => el?.focus(), []);

  const dirty = TEMPLATE_FILES.some((f) => isDirty(files[f]));
  useBlocker({
    shouldBlockFn: () => {
      if (leaving.current || !dirty) return false;
      return !window.confirm("You have unsaved changes. Leave this page and discard them?");
    },
    enableBeforeUnload: () => dirty && !leaving.current,
  });

  const edit = (f: TemplateFile, content: string) => {
    patch(f, { content });
    setOutcomes((all) => (all[f]?.tone === "success" ? { ...all, [f]: undefined } : all));
  };
  const patch = (f: TemplateFile, p: Partial<FileState>) =>
    setFiles((s) => ({ ...s, [f]: { ...s[f], ...p } }));
  const setOutcome = (f: TemplateFile, o?: Outcome) => setOutcomes((s) => ({ ...s, [f]: o }));

  // A jump to another tab can only land once that tab's editor (or its textarea fallback) has
  // mounted, which is after this component's own commit. So the request waits in a ref and is
  // served as soon as either is attached (or immediately, if it already is).
  const wanted = useRef<{ file: TemplateFile; line: number }>(undefined);
  function serveJump() {
    const j = wanted.current;
    if (!j) return;
    const editor = editors.current[j.file];
    if (editor) {
      wanted.current = undefined;
      editor.focusLine(j.line);
      return;
    }
    const el = refs.current[j.file];
    if (!el) return;
    wanted.current = undefined;
    focusTextareaLine(el, j.line);
  }
  // One callback ref per file for the editor's lifetime: a fresh one each render would make React
  // detach and re-attach the textarea (and serve the jump) on every keystroke. serveJump reads
  // only refs, so the first render's copy stays correct.
  const attachers = useState(
    () => new Map<TemplateFile, (el: HTMLTextAreaElement | null) => void>(),
  )[0];
  const attach = (f: TemplateFile) => {
    let cb = attachers.get(f);
    if (!cb) {
      cb = (el) => {
        const prev = refs.current[f];
        // The swap detaches it while it's still in the DOM: note where the user was, for the editor
        // replacing it. Any other detach (a tab switch, Discard) leaves nothing to carry.
        if (!el) carried.current[f] = undefined;
        if (!el && prev && isEditorSettled())
          carried.current[f] = {
            anchor:
              prev.selectionDirection === "backward" ? prev.selectionEnd : prev.selectionStart,
            head: prev.selectionDirection === "backward" ? prev.selectionStart : prev.selectionEnd,
            scrollTop: prev.scrollTop,
            focus: document.activeElement === prev,
          };
        refs.current[f] = el;
        serveJump();
      };
      attachers.set(f, cb);
    }
    return cb;
  };
  // The same for the editor: it serves a waiting jump, else takes over from the fallback.
  const editorAttachers = useState(
    () => new Map<TemplateFile, (h: CodeEditorHandle | null) => void>(),
  )[0];
  const attachEditor = (f: TemplateFile) => {
    let cb = editorAttachers.get(f);
    if (!cb) {
      cb = (h) => {
        editors.current[f] = h;
        if (!h) return;
        const c = carried.current[f];
        carried.current[f] = undefined;
        if (wanted.current?.file === f) return serveJump();
        if (!c) return;
        h.restore(c);
        keepInPlace(document.getElementById(`editor-${f}`), c.scrollTop);
      };
      editorAttachers.set(f, cb);
    }
    return cb;
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: serve a request made on the active tab
  useEffect(serveJump, [jumpN]);

  // Stable (setters and a ref only), so the memoized issues block skips keystroke renders.
  const jumpTo = useCallback((file: TemplateIssue["file"], line: number) => {
    if (!(TEMPLATE_FILES as readonly string[]).includes(file)) return;
    const f = file as TemplateFile;
    setTab(f);
    if (f === "AGENTS.md") setMdView("write");
    wanted.current = { file: f, line };
    setJumpN((n) => n + 1);
  }, []);

  function failed(f: TemplateFile, e: unknown, fallback: string) {
    if (e instanceof ApiError && e.status === 404) return setGone(true);
    setOutcome(f, { tone: "error", text: e instanceof ApiError ? e.message : fallback });
  }

  /** A superseded validate must not leave its "Checking…" line behind (a save or reload may
   *  have replaced it with its own outcome, which stays). */
  function clearChecking(f: TemplateFile) {
    setOutcomes((all) => {
      const o = all[f];
      return o?.tone === "pending" && o.kind === "checking" ? { ...all, [f]: undefined } : all;
    });
  }

  async function validate(f: TemplateFile) {
    const s = files[f];
    if (!s.started || checked.current[f] === s.content) return;
    checked.current[f] = s.content;
    const mine = ++seq.current;
    setOutcome(f, { tone: "pending", text: "Checking…", kind: "checking" });
    try {
      const next = await validateTemplateFile(name, f, s.content);
      if (mine !== seq.current) return clearChecking(f);
      setIssues(next);
      setOutcome(f, undefined);
    } catch (e) {
      if (mine !== seq.current) {
        checked.current[f] = undefined;
        return clearChecking(f);
      }
      checked.current[f] = undefined;
      failed(f, e, "Couldn't check this file. Saving still works.");
    }
  }

  async function save(f: TemplateFile, baseHash = files[f].baseHash) {
    const s = files[f];
    if (!isDirty(s) || isBusy(outcomes[f])) return;
    const mine = ++seq.current;
    patch(f, { conflict: undefined });
    setOutcome(f, { tone: "pending", text: "Saving…", kind: "saving" });
    try {
      const r = await saveTemplateFile(name, f, s.content, baseHash);
      checked.current[f] = s.content;
      // The content may have been edited while the request was in flight.
      setFiles((all) => ({ ...all, [f]: { ...all[f], saved: s.content, baseHash: r.hash } }));
      if (mine === seq.current) setIssues(r.issues);
      setOutcome(f, {
        tone: "success",
        text: r.issues.some((i) => i.severity === "error")
          ? "Saved. Fix the errors before creating agents from this template."
          : "Saved.",
      });
      // Overwrite removes the conflict block that held focus.
      if (baseHash !== s.baseHash) focusEditor(f);
      // The header (display name, runtime, description) and the list read the saved config;
      // the editor itself was seeded once and keeps its own state.
      void qc.invalidateQueries({ queryKey: ["templates"] });
    } catch (e) {
      if (e instanceof ApiError && e.code === "changed_on_disk") {
        const h = e.body.currentHash;
        patch(f, { conflict: { currentHash: typeof h === "string" ? h : null } });
        setOutcome(f, undefined);
      } else failed(f, e, "Couldn't save this file. Try again.");
    }
  }

  async function reload(f: TemplateFile) {
    setOutcome(f, { tone: "pending", text: "Reloading…", kind: "reloading" });
    try {
      const fresh = await qc.fetchQuery({ ...templateQueryOptions(name), staleTime: 0 });
      const s = initial(fresh)[f];
      // The disk's version starts the file over: no undo back into the discarded edits.
      states.delete(`${name}:${f}`);
      patch(f, { ...s, conflict: undefined });
      checked.current[f] = s.content;
      seq.current++;
      setIssues(fresh.issues);
      setOutcome(f, undefined);
      focusEditor(f);
    } catch (e) {
      failed(f, e, "Couldn't reload this file. Try again.");
    }
  }

  // Issues change on a validate or save, not on a keystroke: split them up once per change.
  // Each file's editor markers come from here too, so its diagnostics array is stable between issues.
  const { errorCount, filesWithErrors, issuesByFile, diagsByFile } = useMemo(() => {
    const errors = issues.filter((i) => i.severity === "error");
    const issuesByFile = new Map(
      TEMPLATE_FILES.map((f) => [f, sortIssues(issues.filter((i) => i.file === f))]),
    );
    return {
      errorCount: errors.length,
      filesWithErrors: new Set(errors.map((i) => i.file)),
      issuesByFile,
      diagsByFile: new Map(
        TEMPLATE_FILES.map((f): [TemplateFile, Diag[]] => [
          f,
          (issuesByFile.get(f) ?? []).flatMap((i) =>
            i.line === undefined
              ? []
              : [{ line: i.line, column: i.column, message: i.message, severity: i.severity }],
          ),
        ]),
      ),
    };
  }, [issues]);

  if (gone) {
    return (
      <>
        <PageHeader
          title={template.config?.displayName ?? name}
          titleFromData
          meta={<HeaderSlug value={name} />}
        />
        <PageBody>
          <div className="grid max-w-xl gap-3">
            <p role="alert" className="text-sm">
              {goneMessage}
            </p>
            <div>
              <Button asChild>
                <Link to="/templates">Back to templates</Link>
              </Button>
            </div>
          </div>
        </PageBody>
      </>
    );
  }

  return (
    <>
      <TemplateHeader
        template={template}
        errorCount={errorCount}
        headingId={headingId}
        onDelete={setConfirmOpen}
      />
      <PageBody>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
          {issues.length > 0 && (
            <IssuesBlock
              issues={issues}
              errorCount={errorCount}
              headingId={headingId}
              onJump={jumpTo}
            />
          )}
          <Tabs
            value={tab}
            onValueChange={(v) => setTab(v as TemplateFile)}
            className="min-w-0 gap-3"
          >
            <TabsList
              variant="line"
              className="h-9! w-full justify-start gap-1 overflow-x-auto rounded-none border-b p-0"
            >
              {TEMPLATE_FILES.map((f) => (
                <TabsTrigger
                  key={f}
                  value={f}
                  className="h-full flex-none rounded-none px-2 font-mono text-[0.8125rem] font-normal text-muted-foreground data-[state=active]:text-foreground group-data-horizontal/tabs:after:bottom-0"
                >
                  {filesWithErrors.has(f) && (
                    <>
                      <IssueIcon severity="error" />
                      <span className="sr-only">(has errors)</span>
                    </>
                  )}
                  <span id={labelId(f)}>{f}</span>
                  {isDirty(files[f]) && (
                    <>
                      <span aria-hidden="true" className="size-1.5 rounded-full bg-foreground" />
                      <span className="sr-only">(unsaved)</span>
                    </>
                  )}
                </TabsTrigger>
              ))}
            </TabsList>
            {TEMPLATE_FILES.map((f) => {
              const s = files[f];
              const mine = issuesByFile.get(f) ?? [];
              const outcome = outcomes[f];
              const busy = isBusy(outcome);
              const canSave = isDirty(s) && !busy;
              const save$ = () => void save(f);
              const warmHint = f === "template.yaml" && s.started && warmDefault !== undefined;
              const surface = {
                file: f,
                onBlur: () => void validate(f),
                onSave: save$,
                labelledBy: labelId(f),
                fileKey: `${name}:${f}`,
                states,
                diagnostics: diagsByFile.get(f) ?? NO_DIAGS,
                textareaRef: attach(f),
                editorRef: attachEditor(f),
              };
              return (
                <TabsContent
                  key={f}
                  value={f}
                  className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3"
                >
                  {!s.started ? (
                    <div className="grid justify-items-start gap-2 rounded-lg border border-dashed border-border p-4">
                      <p className="text-sm text-muted-foreground">Not created</p>
                      <Button
                        id={`create-${f}`}
                        variant="ghost"
                        onClick={() => {
                          patch(f, { started: true, content: OPTIONAL_SEED[f] ?? "" });
                          wanted.current = { file: f, line: 1 };
                        }}
                      >
                        Create file
                      </Button>
                    </div>
                  ) : f === "AGENTS.md" ? (
                    <MarkdownEditor
                      value={s.content}
                      onChange={(v) => edit(f, v)}
                      id={`editor-${f}`}
                      view={mdView}
                      onViewChange={setMdView}
                      // Not a useCallback: MarkdownEditor isn't memoized, so a stable one saves nothing.
                      writeSurface={(w) => (
                        <div className={EMBEDDED}>
                          <FileSurface
                            {...surface}
                            value={w.value}
                            onChange={w.onChange}
                            describedBy={w.describedBy}
                          />
                        </div>
                      )}
                    />
                  ) : (
                    <FileSurface
                      {...surface}
                      value={s.content}
                      onChange={(v) => edit(f, v)}
                      describedBy={warmHint ? `editor-${f}-warm-hint` : undefined}
                    />
                  )}
                  {warmHint && (
                    <p
                      id={`editor-${f}-warm-hint`}
                      className="text-[0.8125rem] leading-[1.125rem] text-muted-foreground"
                    >
                      <code className="font-mono">warm_window_minutes</code>:{" "}
                      <span>Omit to use the factory default ({warmDefault} min).</span>
                    </p>
                  )}
                  {s.started && <IssueList issues={mine} showFile={false} />}
                  {s.conflict && (
                    <div className="grid justify-items-start gap-2 text-sm">
                      <p role="alert">This file changed on disk since you opened it.</p>
                      <p id={`conflict-${f}`} className="text-[0.8125rem] text-muted-foreground">
                        Reload discards your edits and shows the file as it is on disk. Overwrite
                        replaces the file on disk with your version.
                      </p>
                      <div className="flex gap-2">
                        <Button
                          ref={focusOnMount}
                          variant="ghost"
                          aria-describedby={`conflict-${f}`}
                          onClick={() => void reload(f)}
                        >
                          Reload
                        </Button>
                        <Button
                          variant="ghost"
                          aria-describedby={`conflict-${f}`}
                          onClick={() => void save(f, s.conflict?.currentHash ?? null)}
                        >
                          Overwrite
                        </Button>
                      </div>
                    </div>
                  )}
                  {s.started && (
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <Status outcome={outcome} />
                      <div className="ml-auto flex gap-2">
                        <Button
                          variant="ghost"
                          aria-disabled={!isDirty(s) || undefined}
                          onClick={() => {
                            if (!isDirty(s)) return;
                            setOutcome(f, undefined);
                            if (isOptional(f) && s.baseHash === null) {
                              // Never written: back to "Not created".
                              patch(f, {
                                started: false,
                                content: "",
                                saved: "",
                                conflict: undefined,
                              });
                              requestAnimationFrame(() =>
                                document.getElementById(`create-${f}`)?.focus(),
                              );
                              return;
                            }
                            patch(f, { content: s.saved, conflict: undefined });
                            focusEditor(f);
                          }}
                        >
                          Discard
                        </Button>
                        <Button
                          aria-disabled={!canSave || undefined}
                          onClick={() => canSave && save$()}
                        >
                          {outcome?.tone === "pending" && outcome.kind === "saving" && <Spinner />}
                          {outcome?.tone === "pending" && outcome.kind === "saving"
                            ? "Saving…"
                            : "Save"}
                        </Button>
                      </div>
                    </div>
                  )}
                </TabsContent>
              );
            })}
          </Tabs>
        </div>
      </PageBody>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Delete template ${name}?`}
        body={
          <>
            This deletes the folder <span className="font-mono">{template.path}</span>.
          </>
        }
        confirmLabel={`Delete ${name}`}
        pendingLabel="Deleting…"
        onConfirm={async () => {
          try {
            await deleteTemplate(name);
          } catch (e) {
            // Already gone: the goal is met.
            if (!(e instanceof ApiError && e.status === 404)) throw e;
          }
          leaving.current = true;
          qc.removeQueries({ queryKey: ["templates", name] });
          await navigate({ to: "/templates", state: deletedState(name) });
        }}
      />
    </>
  );
}

const NO_DIAGS: Diag[] = [];

// Inside MarkdownEditor's frame the surface drops its own frame (border, radius, focus ring).
const EMBEDDED =
  "[&>div>div:first-child]:rounded-none [&>div>div:first-child]:border-0 [&>div>div:first-child]:ring-0! [&>div>p]:px-3 [&>div>p]:pb-2";

/** If the textarea had been scrolled, scroll the editor's container by as much, so the text stays
 *  where it was on screen (the editor grows to its content; the textarea scrolled inside itself). */
function keepInPlace(el: HTMLElement | null, by: number) {
  if (!el || by <= 0) return;
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (p.scrollHeight > p.clientHeight && /auto|scroll/.test(getComputedStyle(p).overflowY)) {
      p.scrollTop += by;
      return;
    }
  }
  window.scrollBy(0, by);
}

type SurfaceProps = Omit<CodeSurfaceProps, "id" | "label" | "language"> & { file: TemplateFile };

/** One template file in the shared code surface, named and typed by its file. */
function FileSurface({ file, ...p }: SurfaceProps) {
  return <CodeSurface {...p} id={`editor-${file}`} label={file} language={LANGUAGE[file]} />;
}

/** The page header and the config line under it. Memoized: neither reads the files being edited,
 *  so typing doesn't re-render them. */
const TemplateHeader = memo(function TemplateHeader({
  template,
  errorCount,
  headingId,
  onDelete,
}: {
  template: TemplateDetail;
  errorCount: number;
  headingId: string;
  onDelete: (open: boolean) => void;
}) {
  const name = template.name;
  // Preloads New agent (chunk and data, the template detail included) on intent.
  const createIntent = useMemo(
    () => sheetIntent("new-agent", { kind: "new-agent", template: name }),
    [name],
  );
  return (
    <>
      <PageHeader
        title={template.config?.displayName ?? name}
        titleFromData
        meta={<HeaderSlug value={name} />}
        actions={
          <>
            {errorCount > 0 ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    aria-disabled="true"
                    aria-describedby={headingId}
                    onClick={(e) => e.preventDefault()}
                  >
                    <UserPlus aria-hidden="true" data-icon="inline-start" />
                    <span className="max-md:sr-only">Create agent</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Fix the errors first</TooltipContent>
              </Tooltip>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    onClick={() => openSheet({ kind: "new-agent", template: name })}
                    {...createIntent}
                  >
                    <UserPlus aria-hidden="true" data-icon="inline-start" />
                    <span className="max-md:sr-only">Create agent</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Create agent</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" onClick={() => onDelete(true)}>
                  <Trash2
                    aria-hidden="true"
                    data-icon="inline-start"
                    className="text-destructive"
                  />
                  <span className="max-md:sr-only">Delete…</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Delete template</TooltipContent>
            </Tooltip>
          </>
        }
      />
      <div className="flex min-h-8 flex-wrap items-center gap-x-2 border-b px-4 py-1 text-[0.8125rem] text-muted-foreground md:px-6">
        {template.config && (
          <span>{template.config.runtime === "docker" ? "Docker" : "Local"}</span>
        )}
        {template.config && <span aria-hidden="true">·</span>}
        {template.imageStatus && (
          <>
            <ImageLine image={template.imageStatus} />
            <span aria-hidden="true">·</span>
          </>
        )}
        <span className="flex min-w-0 max-w-full font-mono">
          <MiddleTruncate text={template.path} />
        </span>
        <span aria-hidden="true">·</span>
        {template.agents.length === 0 ? (
          <span>No agents</span>
        ) : (
          <span className="flex flex-wrap gap-x-1.5">
            {template.agents.length === 1 ? "1 agent:" : `${template.agents.length} agents:`}
            {template.agents.map((slug, i) => (
              <Link
                key={slug}
                to="/agents/$slug/chat"
                params={{ slug }}
                className="rounded-sm font-mono text-foreground underline-offset-2 hover:underline"
              >
                @{slug}
                {i < template.agents.length - 1 ? "," : ""}
              </Link>
            ))}
          </span>
        )}
        {template.avatar.tooLarge && (
          <>
            <span aria-hidden="true">·</span>
            <span className="flex items-center gap-1.5">
              <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0 text-warning" />
              avatar.svg ignored: over 256 KB
            </span>
          </>
        )}
      </div>
    </>
  );
});

/** The template-wide issue list. Memoized like the header: it changes on a validate or save. */
const IssuesBlock = memo(function IssuesBlock({
  issues,
  errorCount,
  headingId,
  onJump,
}: {
  issues: TemplateIssue[];
  errorCount: number;
  headingId: string;
  onJump: (file: TemplateIssue["file"], line: number) => void;
}) {
  return (
    <section
      aria-labelledby={headingId}
      className="grid gap-2 rounded-lg border border-border bg-card p-3"
    >
      <h2 id={headingId} className="text-[0.8125rem] font-medium">
        {errorCount > 0 ? "This template can't be used until the errors are fixed." : "Warnings"}
      </h2>
      <IssueList issues={issues} onJump={onJump} />
    </section>
  );
});

/** One live region that is always mounted, so changes are announced. */
function Status({ outcome }: { outcome?: Outcome }) {
  return (
    <div aria-live="polite" className="min-h-[1.125rem]">
      {outcome?.tone === "pending" && (
        <p className="flex items-center gap-1.5 text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
          <Spinner size="text" />
          {outcome.text}
        </p>
      )}
      {outcome && outcome.tone !== "pending" && (
        <InlineOutcome tone={outcome.tone}>{outcome.text}</InlineOutcome>
      )}
    </div>
  );
}

/** `image:` with its status (spec §12.8), and Build for a user image that isn't built. */
function ImageLine({ image }: { image: NonNullable<TemplateDetail["imageStatus"]> }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  // Once a build starts here the button stays rendered (aria-disabled while it runs), so focus
  // isn't dropped to <body> when the status changes under it.
  const [started, setStarted] = useState(false);
  // Unknown (Docker unreachable) offers no Build here: it would only fail.
  const showBuild =
    image.kind === "user" &&
    image.status !== "no_dockerfile" &&
    image.status !== "unknown" &&
    (image.status !== "built" || started);
  const disabled = pending || image.status === "building";
  const build = async () => {
    setStarted(true);
    setPending(true);
    setError(undefined);
    try {
      await buildImage(image.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  };
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2">
      <span className="font-mono">image: {image.name}</span>
      <ImageStatusLabel status={image.status} className="text-foreground" />
      {showBuild && (
        <Button
          variant="ghost"
          size="xs"
          aria-disabled={disabled || undefined}
          onClick={() => !disabled && void build()}
        >
          Build
        </Button>
      )}
      {error && (
        <span role="alert" className="text-destructive">
          {error}
        </span>
      )}
    </span>
  );
}
