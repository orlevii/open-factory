import type { TemplateConfig, TemplateIssue } from "@open-factory/shared";
import { Link } from "@tanstack/react-router";
import { Plus, TriangleAlert } from "lucide-react";
import { type FocusEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { FieldShell } from "@/components/field-shell";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type TemplateOption = {
  name: string;
  displayName?: string;
  description?: string;
  errors: number;
};

const linkClass =
  "text-foreground underline underline-offset-4 decoration-muted-foreground hover:decoration-ring";

/**
 * New agent's Template (§6.2) on `FieldShell`: a Select whose items show the display name (the trigger's text) with
 * the description muted under it; templates with errors are listed disabled. "New template" is the field's action.
 * With no template the Select gives way to "No templates yet."; with every template broken, to a link to fix them.
 * `onBlur` runs when the trigger loses focus with the list closed (with its event), and when the list closes (after
 * the pick has rendered, with none).
 */
export function TemplateField({
  value,
  onChange,
  templates,
  onNewTemplate,
  error,
  onBlur,
  describedBy,
  children,
}: {
  value: string;
  onChange(name: string): void;
  templates: TemplateOption[];
  onNewTemplate(): void;
  error?: string;
  onBlur?(e?: FocusEvent): void;
  /** Extra ids describing the trigger (the summary below it). */
  describedBy?: string;
  /** Below the field: the chosen template's summary. */
  children?: ReactNode;
}) {
  const [listOpen, setListOpen] = useState(false);
  const opened = useRef(false);
  // Opening a Radix Select moves focus into its list, so the trigger blurs on open: validate when the list closes,
  // once the chosen value has rendered. An effect, not the close handler: the close fires before the pick renders, and
  // this is the only moment the field has been left with its final value. No event, so the hook counts it as a blur.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the list closes
  useEffect(() => {
    if (listOpen || !opened.current) return;
    opened.current = false;
    onBlur?.();
  }, [listOpen]);

  const ready = templates.filter((t) => t.errors === 0);
  const broken = templates.filter((t) => t.errors > 0);
  // No Select to label: the empty state's text stands in for it, so a failing submit focuses it and it carries the note.
  const empty = (a: { id: string; describedBy?: string; invalid: boolean }) => ({
    id: a.id,
    tabIndex: -1,
    "aria-describedby": a.describedBy,
    "aria-invalid": a.invalid || undefined,
    className: "text-[0.8125rem] text-muted-foreground",
  });
  return (
    <FieldShell
      name="template"
      label="Template"
      plainLabel={ready.length === 0}
      error={error}
      describedBy={describedBy}
      action={
        <Button
          type="button"
          variant="ghost"
          size="sm"
          inForm
          data-skip-validate
          onClick={onNewTemplate}
        >
          <Plus aria-hidden="true" data-icon="inline-start" />
          New template
        </Button>
      }
      below={children}
    >
      {(a) =>
        templates.length === 0 ? (
          <p {...empty(a)}>No templates yet.</p>
        ) : ready.length === 0 ? (
          <p {...empty(a)}>
            No template is ready: fix the errors in{" "}
            {broken.length === 1 ? (
              <Link
                to="/templates/$name"
                params={{ name: broken[0]?.name ?? "" }}
                className={`font-mono ${linkClass}`}
              >
                {broken[0]?.name}
              </Link>
            ) : (
              <Link to="/templates" className={linkClass}>
                {broken.length} templates
              </Link>
            )}
            .
          </p>
        ) : (
          <Select
            // A name no ready template has (an unknown or broken `?template=`) shows unchosen: the placeholder.
            value={ready.some((t) => t.name === value) ? value : ""}
            onValueChange={onChange}
            onOpenChange={(open) => {
              setListOpen(open);
              if (open) opened.current = true;
            }}
          >
            <SelectTrigger
              id={a.id}
              aria-invalid={a.invalid || undefined}
              aria-describedby={a.describedBy}
              onBlur={(e) => !listOpen && onBlur?.(e)}
            >
              <SelectValue placeholder="Choose a template" />
            </SelectTrigger>
            {/* The list scrolls within its own height, also inside a drawer. */}
            <SelectContent className="max-h-[min(20rem,var(--radix-select-content-available-height))]">
              {templates.map((t) =>
                t.errors > 0 ? (
                  <SelectItem key={t.name} value={t.name} disabled>
                    {`${t.name} (has errors)`}
                  </SelectItem>
                ) : (
                  <SelectItem key={t.name} value={t.name} description={t.description || undefined}>
                    {t.displayName || t.name}
                  </SelectItem>
                ),
              )}
            </SelectContent>
          </Select>
        )
      }
    </FieldShell>
  );
}

/** What the chosen template brings: its description in full (touch has no `title`), then the warnings that would stop
 *  its agents starting: the validator's runtime warning and secrets that aren't set, each with "Add secret" (§7.3)
 *  when the form can stack that sheet. */
export function TemplateSummary({
  config,
  pluginCount,
  issues,
  missingSecrets,
  onAddSecret,
}: {
  config: TemplateConfig;
  /** The plugins the template enables: its list row's `pluginCount`, since the config has none. */
  pluginCount: number;
  issues: TemplateIssue[];
  missingSecrets: string[];
  onAddSecret?(name: string): void;
}) {
  const runtimeWarnings = issues
    .filter((i) => i.severity === "warning" && i.path === "runtime")
    .map((i) => i.message);
  const parts = [
    config.runtime === "docker" ? "Docker" : "Unsandboxed",
    config.model && `model ${config.model}`,
    config.skills.length > 0 && `skills: ${config.skills.join(", ")}`,
    pluginCount > 0 && `plugins: ${pluginCount}`,
    config.secrets.length > 0 && `secrets: ${config.secrets.join(", ")}`,
  ].filter(Boolean);
  return (
    <div id="template-summary" className="grid gap-1 text-[0.8125rem] leading-[1.125rem]">
      {config.description && (
        <p className="text-muted-foreground [overflow-wrap:anywhere]">{config.description}</p>
      )}
      <p className="text-muted-foreground">{parts.join(" · ")}</p>
      {runtimeWarnings.map((w) => (
        <Warning key={w}>{w}</Warning>
      ))}
      {missingSecrets.map((s) => (
        <Warning
          key={s}
          action={
            onAddSecret && (
              <Button type="button" variant="ghost" size="sm" inForm onClick={() => onAddSecret(s)}>
                Add secret
              </Button>
            )
          }
        >
          {/* Secret names have no break points. */}
          Secret <span className="font-mono [overflow-wrap:anywhere]">{s}</span> isn't set. The
          agent won't start until you add it.
        </Warning>
      ))}
    </div>
  );
}

function Warning({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-start gap-1.5">
      <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-warning" />
      <span className="min-w-0 flex-1">{children}</span>
      {action && <span className="-my-1 shrink-0">{action}</span>}
    </div>
  );
}
