import type { EditorState } from "@codemirror/state";
import {
  type AgentConfigResponse,
  type AgentOverlay,
  type AgentSummary,
  ApiError,
  canonicalJson,
  describeChanges,
  mergeConfig,
  summarizeChanges,
  type TemplateIssue,
  templateIssueSchema,
} from "@open-factory/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useBlocker } from "@tanstack/react-router";
import {
  memo,
  type ReactNode,
  useCallback,
  useDeferredValue,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { z } from "zod";
import { AgentAvatar } from "@/components/agent-avatar";
import { ErrorLine } from "@/components/error-line";
import { PageBody, PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BackToAgent } from "@/features/agents/back-to-agent";
import { agentDetailQueryOptions } from "@/features/session/api";
import type { CodeEditorHandle } from "@/features/templates/code-editor";
import { focusTextareaLine } from "@/features/templates/code-surface";
import { IssueIcon } from "@/features/templates/issue-list";
import {
  agentConfigQueryOptions,
  cacheSavedAgentConfig,
  saveAgentConfigMutation,
  templateConfigQueryOptions,
} from "./api";
import { ConfigForm, type RawTarget } from "./config-form";
import {
  ArchivedBlock,
  BrokenTemplateBlock,
  RestartPendingLine,
  SpawnedConfig,
} from "./config-states";
import { jsonPathToLine } from "./json-path-line";
import {
  CONFIG_FORM_MSG,
  CONFIG_PAGE_COPY,
  CONFIG_PAGE_MSG,
  restartNotice,
  savedRestarts,
  savedSchemaOnly,
} from "./messages";
import { PageFooter } from "./page-footer";
import { clearTransient, NO_PAGE_OUTCOME, toFormOutcome, usePageOutcome } from "./page-outcome";
import { type ParseError, parseErrorAt, RawJsonTab, type RawView } from "./raw-json-tab";
import { useConfigDraft } from "./use-config-draft";

type Tab = "config" | "raw";
/**
 * The Raw JSON text and what it stands for. `forDraft` is the draft value it was parsed into or serialized from: while
 * the draft is that same value the text (key order, spacing, undo) is kept, and when it isn't, the text is re-serialized
 * only if the canonical JSON differs. `error` is set while the text doesn't parse; the draft then keeps the last valid.
 */
type RawState = { text: string; forDraft: unknown; error: ParseError | null };
const isRec = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const serialize = (v: unknown) => `${JSON.stringify(v, null, 2) ?? "null"}\n`;
const isRunning = (a: AgentSummary) => a.status === "working" || a.status === "idle";
const issuesBody = z.object({ issues: z.array(templateIssueSchema) });

/** The raw state for a draft: the same one while it still stands for it, else re-serialized (M4: in a handler). */
function rawFor(draft: unknown, prev: RawState | null): RawState {
  if (prev && (prev.error || prev.forDraft === draft)) return prev;
  if (prev && canonicalJson(prev.forDraft) === canonicalJson(draft))
    return { ...prev, forDraft: draft };
  return { text: serialize(draft), forDraft: draft, error: null };
}

/** Memoized: on the Raw tab the hidden form gets the deferred draft, so typing JSON never waits on it. */
const Form = memo(ConfigForm);

/**
 * The Agent Configuration page (spec §12.4): the header shared with Usage, then the state blocks, the Configuration
 * and Raw JSON tabs over one draft, the restart notice and the page footer. A spawned agent gets its read-only view.
 */
export function AgentConfigPage({ slug }: { slug: string }) {
  const detail = useQuery(agentDetailQueryOptions(slug));
  const config = useQuery(agentConfigQueryOptions(slug));
  const agent = detail.data?.agent;
  let body: ReactNode;
  if (!agent || !config.data)
    body =
      detail.isError || config.isError ? (
        <ErrorLine
          text={CONFIG_PAGE_MSG.couldntLoad}
          onRetry={() => {
            void detail.refetch();
            void config.refetch();
          }}
        />
      ) : (
        <Skeleton className="h-40" />
      );
  else if (agent.kind === "ephemeral")
    body = <SpawnedConfig agent={agent} merged={config.data.merged} />;
  else body = <AgentConfigEditor key={slug} agent={agent} config={config.data} />;
  return (
    <>
      <ConfigHeader slug={slug} agent={agent} />
      <PageBody>
        <div className="grid max-w-[44rem] min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
          <BackToAgent slug={slug} />
          {body}
        </div>
      </PageBody>
    </>
  );
}

/** The Usage page's header: the agent's avatar, "Configuration", and "@ana · Template dev". */
const ConfigHeader = memo(function ConfigHeader({
  slug,
  agent,
}: {
  slug: string;
  agent: AgentSummary | undefined;
}) {
  return (
    <PageHeader
      wrap
      title={CONFIG_PAGE_COPY.title}
      documentTitle={`${CONFIG_PAGE_COPY.title} · ${agent?.displayName ?? `@${slug}`}`}
      leading={
        agent ? (
          <AgentAvatar
            slug={slug}
            template={agent.template}
            avatarVersion={agent.avatarVersion}
            color={agent.color}
            size={24}
          />
        ) : undefined
      }
      meta={
        agent ? (
          // Never hidden: on a narrow header it moves to its own line under the title, and wraps.
          <span
            data-slot="config-meta"
            className="min-w-0 text-[0.8125rem] text-muted-foreground [overflow-wrap:anywhere] @max-[28rem]:order-last @max-[28rem]:basis-full"
          >
            <span className="font-mono">@{slug}</span> · Template{" "}
            <Link
              to="/templates/$name"
              params={{ name: agent.template }}
              className="font-mono text-foreground underline-offset-2 hover:underline"
            >
              {agent.template}
            </Link>
          </span>
        ) : undefined
      }
    />
  );
});

function AgentConfigEditor({
  agent,
  config,
}: {
  agent: AgentSummary;
  config: AgentConfigResponse;
}) {
  const slug = agent.slug;
  const qc = useQueryClient();
  const save = useMutation(saveAgentConfigMutation(slug));
  // The template's own skills/ folders, for the read-only "Template skill" rows (the agent GET doesn't carry them).
  const localSkills = useQuery(templateConfigQueryOptions(agent.template)).data?.localSkills;
  const loaded = useMemo(
    () => ({ value: config.overlay as unknown, version: config.version }),
    [config.overlay, config.version],
  );
  const d = useConfigDraft<unknown>(loaded);
  const [tab, setTab] = useState<Tab>("config");
  const [raw, setRaw] = useState<RawState | null>(null);
  const [rawView, setRawView] = useState<RawView>("agent");
  const [refusals, setRefusals] = useState(0);
  const [editorOpen, setEditorOpen] = useState(false);
  // Bumped by Discard, Undo and Reload: the form remounts, so an open MCP editor (its own draft) goes with the
  // discarded edits instead of bringing them back on Done. Its unmount reports the editor closed.
  const [formEpoch, setFormEpoch] = useState(0);
  const { outcome, outcomeKey, setOutcome } = usePageOutcome();
  const [issuesOverride, setIssuesOverride] = useState<TemplateIssue[] | null>(null);
  const [footerHeight, setFooterHeight] = useState(0);
  // The editor states (doc, selection, undo) of this agent's raw text and its Combined view, kept across tab switches.
  const states = useState(() => new Map<string, EditorState>())[0];
  const editor = useRef<CodeEditorHandle | null>(null);
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  // A jump into Raw waits here until its editor (or the fallback textarea) attaches.
  const pendingLine = useRef<number | undefined>(undefined);
  const discardedRaw = useRef<RawState | null>(null);
  // The latest committed draft hook, for the handlers that resume after a request (useLatest).
  const latest = useRef(d);
  const latestRaw = useRef(raw);
  useLayoutEffect(() => {
    latest.current = d;
    latestRaw.current = raw;
  });
  const rawLabelId = useId();
  const saveId = useId();

  const base = config.template.doc;
  const valid = config.template.valid;
  const issues = issuesOverride ?? config.issues;
  const running = isRunning(agent);
  const dirty = d.dirty || raw?.error != null;
  const rawError = raw?.error ?? null;

  useBlocker({
    shouldBlockFn: () => dirty && !window.confirm(CONFIG_PAGE_COPY.leaveConfirm),
    enableBeforeUnload: () => dirty,
  });

  // On the Raw tab, follow a draft changed by something other than the text (Discard, Undo, a rebase): adjusting
  // state during render, never in an effect. A no-op while the text still stands for the draft.
  let shownRaw = raw;
  if (tab === "raw") {
    const next = rawFor(d.draft, raw);
    if (next !== raw) {
      setRaw(next);
      shownRaw = next;
    }
  }

  // M2: everything derived from the whole draft runs on the deferred one, so typing never waits on it.
  const deferred = useDeferredValue(d.draft);
  // Against the base my edits started from, not the loaded overlay: while drifted, a remote change must not read as
  // one of mine.
  const mineFrom = d.baseValue;
  const restartSummary = useMemo(() => {
    if (!running || !base || deferred === mineFrom || !isRec(deferred) || !isRec(mineFrom))
      return "";
    try {
      return summarizeChanges(
        describeChanges(
          mergeConfig(base, mineFrom as AgentOverlay),
          mergeConfig(base, deferred as AgentOverlay),
        ),
      );
    } catch {
      return "";
    }
  }, [running, base, deferred, mineFrom]);
  const combinedText = useMemo(() => {
    if (tab !== "raw" || rawView !== "combined" || !base || !isRec(deferred)) return null;
    try {
      return serialize(mergeConfig(base, deferred as AgentOverlay));
    } catch {
      return null;
    }
  }, [tab, rawView, base, deferred]);

  const focusRawLine = useCallback((line: number) => {
    if (editor.current) return editor.current.focusLine(line);
    if (textarea.current) return focusTextareaLine(textarea.current, line);
    pendingLine.current = line;
  }, []);
  const attachEditor = useCallback((h: CodeEditorHandle | null) => {
    editor.current = h;
    const line = pendingLine.current;
    if (h && line !== undefined) {
      pendingLine.current = undefined;
      h.focusLine(line);
    }
  }, []);
  const attachTextarea = useCallback((el: HTMLTextAreaElement | null) => {
    textarea.current = el;
    const line = pendingLine.current;
    if (el && line !== undefined) {
      pendingLine.current = undefined;
      focusTextareaLine(el, line);
    }
  }, []);

  /** A switch away from broken JSON: refused, focus on the error, the note announced (R3). */
  function refuse(error: ParseError) {
    setRefusals((n) => n + 1);
    // After the press's own default focus (a tab trigger takes focus on mousedown).
    requestAnimationFrame(() => focusRawLine(error.line));
  }

  // M4: the raw work of a tab change (the parse check, the serialization) runs here, in the handler.
  function onTabChange(value: string) {
    const next = value as Tab;
    if (next === tab) return;
    if (tab === "raw" && rawError) return refuse(rawError);
    if (next === "raw") setRaw(rawFor(d.draft, raw));
    setTab(next);
  }

  function onRawViewChange(next: RawView) {
    if (next === rawView) return;
    if (next === "combined" && rawError) return refuse(rawError);
    setRawView(next);
  }

  const { setDraft } = d;
  const onFormChange = useCallback(
    (update: (prev: unknown) => unknown) => {
      setOutcome(clearTransient);
      setDraft(update);
    },
    [setDraft, setOutcome],
  );

  function onRawChange(text: string) {
    setOutcome(clearTransient);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      // Still an edit: it ends an earlier Discard's Undo, as one that parses does.
      d.touch();
      setRaw({ text, forDraft: raw?.forDraft ?? d.draft, error: parseErrorAt(text, e) });
      return;
    }
    setRaw({ text, forDraft: parsed, error: null });
    setRefusals(0);
    setDraft(() => parsed);
  }

  /** "Revert raw edits": the text goes back to the last valid draft. */
  function onRevert() {
    flushSync(() => {
      setRaw(null);
      setRefusals(0);
    });
    focusRawLine(1);
  }

  // Stable (refs and setters only), so the memoized form skips the renders typing in Raw causes.
  const onShowRaw = useCallback((at: RawTarget) => {
    const r = rawFor(latest.current.draft, latestRaw.current);
    setRaw(r);
    setRawView("agent");
    setTab("raw");
    pendingLine.current = (at.path ? jsonPathToLine(r.text, at.path) : undefined) ?? 1;
  }, []);

  function onDiscard() {
    // Only an MCP editor open, nothing edited: close it (the remount), with no "Discarded." and nothing to undo.
    if (!dirty) {
      setFormEpoch((n) => n + 1);
      return;
    }
    discardedRaw.current = raw && !raw.error ? raw : null;
    d.discard();
    setRaw(null);
    setRefusals(0);
    setIssuesOverride(null);
    setFormEpoch((n) => n + 1);
    setOutcome({ kind: "discarded", text: CONFIG_PAGE_MSG.discarded });
  }

  function onUndo() {
    latest.current.undoDiscard();
    setRaw(discardedRaw.current);
    discardedRaw.current = null;
    setFormEpoch((n) => n + 1);
    setOutcome(NO_PAGE_OUTCOME);
  }

  async function onSave() {
    if (save.isPending || rawError) return;
    if (editorOpen) {
      // The open MCP editor's edits aren't in the draft until its Done: nothing is sent (C3 review I2).
      flushSync(() => {
        setTab("config");
        setOutcome({ kind: "error", text: CONFIG_FORM_MSG.finishServer });
      });
      document.getElementById("field-mcp-name")?.focus();
      return;
    }
    if (!d.dirty) return;
    const sent = d.draft;
    if (!isRec(sent)) return setOutcome({ kind: "error", text: CONFIG_PAGE_MSG.notObject });
    // The restart notice's rule, as the user saw it when they pressed Save.
    const restarts = restartSummary !== "";
    setOutcome(NO_PAGE_OUTCOME);
    let r: Awaited<ReturnType<typeof save.mutateAsync>>;
    try {
      r = await save.mutateAsync({ overlay: sent, baseVersion: d.baseVersion });
    } catch (e) {
      if (e instanceof ApiError && e.code === "config_changed")
        return setOutcome({ kind: "conflict" });
      const body = e instanceof ApiError ? issuesBody.safeParse(e.body) : null;
      if (body?.success) {
        setIssuesOverride(body.data.issues);
        return setOutcome({ kind: "error", text: CONFIG_PAGE_MSG.hasErrors });
      }
      return setOutcome({ kind: "error", text: CONFIG_PAGE_MSG.couldntSave });
    }
    cacheSavedAgentConfig(qc, slug, r);
    // Edits made while the request ran are kept, re-applied over what was saved.
    if (latest.current.draft === sent) latest.current.reset();
    else latest.current.rebase({ value: r.overlay, version: r.version });
    setIssuesOverride(null);
    setOutcome({
      kind: "saved",
      text:
        r.checked === "schema"
          ? savedSchemaOnly(config.template.name)
          : restarts && r.changes.length > 0
            ? savedRestarts(slug)
            : CONFIG_PAGE_MSG.saved,
    });
    // Edit agent's model summary reads the agent's detail.
    void qc.invalidateQueries({ queryKey: agentDetailQueryOptions(slug).queryKey, exact: true });
  }

  /** 409 → Reload: fetch the new version and re-apply my edits over it (R4). Still unsaved. */
  async function onReload() {
    try {
      const fresh = await qc.fetchQuery(agentConfigQueryOptions(slug));
      latest.current.rebase({ value: fresh.overlay, version: fresh.version });
      setFormEpoch((n) => n + 1);
      setIssuesOverride(null);
      setOutcome(NO_PAGE_OUTCOME);
      // The Reload button went with the conflict line: focus moves to Save, the next step.
      document.getElementById(saveId)?.focus();
    } catch {
      setOutcome({ kind: "error", text: CONFIG_PAGE_MSG.couldntReload });
    }
  }

  // A refetch moved the overlay under my edits (focus, WS): the conflict line shows now, with Reload, not at Save.
  const { outcome: footerOutcome, shown: outcomeShown } = toFormOutcome(outcome, outcomeKey, {
    drift: d.drift,
    notice: rawError ? CONFIG_PAGE_MSG.fixJsonToSave : undefined,
    onUndo,
    onReload: () => void onReload(),
  });

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-8">
      {agent.restartPending || agent.archivedAt || !valid ? (
        <div className="grid gap-3">
          {agent.restartPending ? <RestartPendingLine changes={agent.restartChanges} /> : null}
          {agent.archivedAt ? <ArchivedBlock slug={slug} /> : null}
          {!valid ? <BrokenTemplateBlock slug={slug} template={config.template.name} /> : null}
        </div>
      ) : null}
      <Tabs
        value={tab}
        onValueChange={onTabChange}
        activationMode="manual"
        className="min-w-0 gap-4"
      >
        <TabsList
          variant="line"
          className="h-9! w-full justify-start gap-1 rounded-none border-b p-0"
        >
          <TabsTrigger value="config" className={TAB}>
            {CONFIG_PAGE_COPY.tabForm}
          </TabsTrigger>
          <TabsTrigger value="raw" className={TAB}>
            {rawError ? (
              <>
                <IssueIcon severity="error" />
                <span className="sr-only">(has errors)</span>
              </>
            ) : null}
            <span id={rawLabelId}>{CONFIG_PAGE_COPY.tabRaw}</span>
          </TabsTrigger>
        </TabsList>
        {/* M1: always mounted, hidden while Raw shows, so the form's own state (an open MCP editor, Show all)
            survives a visit to Raw. Not <Activity>: a hidden Activity runs effect cleanups, and the form reports an
            open MCP editor closed from one. Radix lets `hidden` override its own under forceMount. */}
        <TabsContent value="config" forceMount hidden={tab !== "config"} className="min-w-0">
          <Form
            key={formEpoch}
            mode="agent"
            value={tab === "config" ? d.draft : deferred}
            base={base}
            templateName={config.template.name}
            onChange={onFormChange}
            readOnly={!valid}
            issues={issues}
            conflicts={d.conflicts}
            onShowRaw={onShowRaw}
            localSkills={localSkills}
            onEditorOpenChange={setEditorOpen}
          />
        </TabsContent>
        <TabsContent value="raw" className="min-w-0">
          <RawJsonTab
            slug={slug}
            labelledBy={rawLabelId}
            text={shownRaw?.text ?? ""}
            onTextChange={onRawChange}
            parseError={rawError}
            issues={issues}
            conflicts={d.conflicts}
            view={rawView}
            onViewChange={onRawViewChange}
            combinedText={combinedText}
            states={states}
            editorRef={attachEditor}
            textareaRef={attachTextarea}
            refusals={refusals}
            onRevert={onRevert}
            onSave={() => void onSave()}
            scrollMarginBottom={footerHeight}
          />
        </TabsContent>
      </Tabs>
      {/* In the page flow above the footer, not in it. Both are children of the page column, so the footer's
          sticky range is the whole column. */}
      {restartSummary ? (
        <p className="-mb-5 text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
          {restartNotice(slug, restartSummary)}
        </p>
      ) : null}
      <PageFooter
        outcome={footerOutcome}
        sticky={dirty || outcomeShown}
        pending={save.isPending}
        canSave={dirty && !rawError}
        canDiscard={dirty || editorOpen}
        onSave={() => void onSave()}
        onDiscard={onDiscard}
        onHeight={setFooterHeight}
        saveId={saveId}
      />
    </div>
  );
}

const TAB =
  "h-full flex-none rounded-none px-2 text-[0.8125rem] font-normal text-muted-foreground data-[state=active]:text-foreground group-data-horizontal/tabs:after:bottom-0";
