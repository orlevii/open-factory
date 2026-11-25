import type { EditorState } from "@codemirror/state";
import { type AgentSummary, summarizeChanges } from "@open-factory/shared";
import { Link } from "@tanstack/react-router";
import { Archive, RotateCw, TriangleAlert } from "lucide-react";
import { type ReactNode, useId, useMemo, useState } from "react";
import { CodeSurface } from "@/features/templates/code-surface";
import { archivedLine, brokenTemplateLine, CONFIG_PAGE_COPY, restartPendingLine } from "./messages";

const LINK =
  "text-foreground underline underline-offset-4 decoration-muted-foreground hover:decoration-ring";

/** A persistent block above the form: a plate with a rule, its icon, a line and its actions. */
function Block({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border bg-card p-3 text-sm leading-5 [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0">
      {icon}
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1 [overflow-wrap:anywhere]">
        {children}
      </div>
    </div>
  );
}

/** "@ana is archived. Changes apply when it's restored." The form stays editable. */
export function ArchivedBlock({ slug }: { slug: string }) {
  return (
    <Block icon={<Archive aria-hidden="true" className="text-muted-foreground" />}>
      <p>{archivedLine(slug)}</p>
    </Block>
  );
}

/** R5: the template is broken or missing. The form is read-only with no inherited base; Raw stays editable. */
export function BrokenTemplateBlock({ slug, template }: { slug: string; template: string }) {
  return (
    <Block icon={<TriangleAlert aria-hidden="true" className="text-destructive" />}>
      <p>{brokenTemplateLine(template, slug)}</p>
      <Link to="/templates/$name" params={{ name: template }} className={LINK}>
        {CONFIG_PAGE_COPY.openTemplate}
      </Link>
    </Block>
  );
}

/** The restart-pending top line: "Restarts when idle to apply: model, 1 skill." */
export function RestartPendingLine({ changes }: { changes: readonly string[] }) {
  const summary = useMemo(() => summarizeChanges([...changes]), [changes]);
  return (
    <p className="flex items-start gap-1.5 text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
      <RotateCw aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      {restartPendingLine(summary)}
    </p>
  );
}

const ignore = () => {};

/**
 * A spawned agent has no configuration of its own (spec §12.4): its template's, plus its spawner's deny rules and
 * secret limits. Below the line, the combined view, read-only. The API serves the current resolve, so it is labelled
 * "Next start".
 */
export function SpawnedConfig({ agent, merged }: { agent: AgentSummary; merged: unknown }) {
  const labelId = useId();
  const states = useState(() => new Map<string, EditorState>())[0];
  const text = useMemo(
    () => (merged === null ? null : `${JSON.stringify(merged, null, 2)}\n`),
    [merged],
  );
  const spawner = agent.reportsTo.kind === "agent" ? agent.reportsTo.handle : null;
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
      <p className="text-sm leading-5">
        {CONFIG_PAGE_COPY.spawnedLead}
        {spawner ? (
          <>
            {CONFIG_PAGE_COPY.spawnedPlus}{" "}
            <Link to="/agents/$slug/chat" params={{ slug: spawner }} className={LINK}>
              @{spawner}
            </Link>
            {CONFIG_PAGE_COPY.spawnedLimits}
          </>
        ) : (
          "."
        )}{" "}
        <Link to="/templates/$name" params={{ name: agent.template }} className={LINK}>
          {CONFIG_PAGE_COPY.openTemplate} {agent.template}
        </Link>
      </p>
      <h2 id={labelId} className="text-sm font-semibold">
        {CONFIG_PAGE_COPY.nextStart}
      </h2>
      {text === null ? (
        <p className="text-sm text-muted-foreground">{CONFIG_PAGE_COPY.noCombined}</p>
      ) : (
        <CodeSurface
          id="spawned-config"
          label={CONFIG_PAGE_COPY.nextStart}
          labelledBy={labelId}
          language="json"
          value={text}
          onChange={ignore}
          fileKey={`agent:${agent.slug}:combined`}
          states={states}
          diagnostics={NO_DIAGS}
          readOnly
        />
      )}
    </div>
  );
}

const NO_DIAGS: never[] = [];
