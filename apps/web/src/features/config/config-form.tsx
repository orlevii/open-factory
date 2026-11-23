import type { TemplateIssue } from "@open-factory/shared";
import { memo, useId, useMemo } from "react";
import { CodeText } from "@/components/code-text";
import { Button } from "@/components/ui/button";
import { IssueIcon, sortIssues } from "@/features/templates/issue-list";
import { EffortField } from "./effort-field";
import { fieldForPath } from "./fields";
import { CONFIG_COPY, CONFIG_FIELD_MSG } from "./messages";
import { ModelField } from "./model-field";
import { type ConfigFormProps, ConfigFormScope, type RawTarget } from "./scope";
import { Section } from "./section";

export type { ConfigFormProps, RawTarget } from "./scope";

/**
 * The Configuration form (spec §12.2), one for a template and an agent. It is controlled: the draft lives in the page
 * (`useConfigDraft`), shared with Raw JSON, and every edit goes through `onChange` as a functional update that keeps
 * every key the form doesn't own. Sections follow in the spec's order; the rest arrive with C3.
 */
export function ConfigForm(props: ConfigFormProps) {
  const { issues, conflicts, onShowRaw } = props;
  // Issues and rebase conflicts no field owns: listed once at the top, each with a way into Raw JSON. A conflict a
  // field owns reads "Also changed elsewhere." on that field, so every conflict shows somewhere.
  const unmapped = useMemo((): BlockItem[] => {
    const owned = (path?: string) => (path ? fieldForPath(path) !== null : false);
    return [
      ...sortIssues(issues.filter((i) => !owned(i.path))),
      ...(conflicts ?? [])
        .filter((p) => !owned(p))
        .map((path) => ({
          severity: "warning" as const,
          message: CONFIG_FIELD_MSG.alsoChanged,
          path,
        })),
    ];
  }, [issues, conflicts]);
  return (
    <ConfigFormScope {...props}>
      {unmapped.length > 0 ? <IssuesBlock issues={unmapped} onShowRaw={onShowRaw} /> : null}
      <Section title="Model">
        <ModelField />
        <EffortField />
      </Section>
    </ConfigFormScope>
  );
}

/** A server issue, or a rebase conflict on a path no field owns. */
type BlockItem = Pick<TemplateIssue, "severity" | "message" | "path"> &
  Partial<Pick<TemplateIssue, "file" | "line">>;

const IssuesBlock = memo(function IssuesBlock({
  issues,
  onShowRaw,
}: {
  issues: readonly BlockItem[];
  onShowRaw?: (at: RawTarget) => void;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="grid gap-2 rounded-lg border border-border bg-card p-3"
    >
      <h2 id={id} className="text-[0.8125rem] font-medium">
        {CONFIG_COPY.issuesHeading}
      </h2>
      <ul className="grid gap-1.5">
        {issues.map((i, n) => {
          const msgId = `${id}-${n}`;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: a list that is replaced as a whole
            <li key={n} className="flex items-start gap-2 text-sm leading-5">
              <IssueIcon severity={i.severity} />
              <span id={msgId} className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                <span className="sr-only">{i.severity === "error" ? "Error: " : "Warning: "}</span>
                <CodeText text={i.message} />
                {i.path ? (
                  <span className="ml-1.5 font-mono text-[0.8125rem] text-muted-foreground">
                    {i.path}
                  </span>
                ) : null}
              </span>
              {onShowRaw ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  aria-describedby={msgId}
                  onClick={() => onShowRaw({ path: i.path, file: i.file, line: i.line })}
                >
                  {CONFIG_COPY.showInRaw}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
});
