import type { ConfigDoc, TemplateIssue } from "@open-factory/shared";
import { imageRefSchema, modelSchema } from "@open-factory/shared";
import { createContext, type ReactNode, use, useCallback, useMemo, useRef } from "react";
import { type FieldErrors, useFieldErrors } from "@/components/forms/use-field-errors";
import type { RowNote } from "./config-list";
import { CONFIG_FIELDS, type ConfigField, FIELD_PATHS, fieldForPath } from "./fields";
import { CONFIG_FIELD_MSG } from "./messages";
import { readAt, readNumber, readString, setAt } from "./tolerant";

export type ConfigMode = "template" | "agent";
/** Where "Show in Raw JSON" goes: an overlay path (agent page), or a file and line (template editor). */
export type RawTarget = { path?: string; file?: TemplateIssue["file"]; line?: number };
export type ConfigUpdate = (update: (prev: unknown) => unknown) => void;

export type ConfigFormProps = {
  mode: ConfigMode;
  /** The draft: an overlay (agent) or a ConfigDoc (template). Raw JSON may have made it any JSON; it is read tolerantly. */
  value: unknown;
  /** Agent mode: the template's doc, for the "From template" rows and inherited values. Null while the template is broken. */
  base?: ConfigDoc | null;
  /** Agent mode: the template's name, for "From template dev · 40". */
  templateName?: string;
  /** A functional update of the whole draft (`useConfigDraft().setDraft`). */
  onChange: ConfigUpdate;
  readOnly?: boolean;
  /** Why the fields cannot be used yet ("Choose a template first"): they are read-only and their help says so. */
  disabledReason?: string;
  /** Replaces the form's section layout (a grid with 2rem between sections), for a scope around a few fields. */
  className?: string;
  /** Server issues. A path a field owns lands on that field (or row); the rest go to the top block. */
  issues: readonly TemplateIssue[];
  /** Paths a rebase found changed on both sides: their fields read "Also changed elsewhere." */
  conflicts?: readonly string[];
  onShowRaw?: (at: RawTarget) => void;
  /** The template's own `skills/` folders (from the template config API), listed read-only as "Template skill". */
  localSkills?: readonly string[];
};

/** A field's own issue, and the notes on its items (the path under the field: a list index, or an entry name and below), with their severity. */
type FieldIssues = { error?: string; warning?: string; items: Map<string, RowNote> };

export type ConfigScope = {
  mode: ConfigMode;
  readOnly: boolean;
  disabledReason?: string | undefined;
  value: unknown;
  base: ConfigDoc | null;
  inheritedLabel: string;
  /** Set the value at a path from its previous value, keeping every other key. Stable while `onChange` is. */
  update: (path: readonly string[], next: (prev: unknown) => unknown) => void;
  byField: ReadonlyMap<ConfigField, FieldIssues>;
  conflicts: ReadonlySet<ConfigField>;
  fieldErrors: FieldErrors<ConfigField>;
  onShowRaw?: (at: RawTarget) => void;
};

const Scope = createContext<ConfigScope | null>(null);

export function useConfigScope(): ConfigScope {
  const s = use(Scope);
  if (!s) throw new Error("useConfigScope outside ConfigFormScope");
  return s;
}

/** A template doc keeps its three parts and `mcp.mcpServers` even when emptied. */
const keepDocParts = (p: readonly string[]) =>
  p.length === 1 || (p.length === 2 && p[0] === "mcp" && p[1] === "mcpServers");
const keepNothing = () => false;

const NUMBER_RANGE = {
  warmWindow: { min: 1, max: 1440, message: CONFIG_FIELD_MSG.warmWindowRange },
} as const;

function numberCheck(value: unknown, f: keyof typeof NUMBER_RANGE): string | undefined {
  const r = readNumber(readAt(value, FIELD_PATHS[f]));
  if (!r.ok || r.value === undefined) return undefined;
  const { min, max, message } = NUMBER_RANGE[f];
  return Number.isInteger(r.value) && r.value >= min && r.value <= max ? undefined : message;
}

function modelCheck(value: unknown): string | undefined {
  const r = readString(readAt(value, FIELD_PATHS.model));
  if (!r.ok || r.value === undefined) return undefined;
  const p = modelSchema.safeParse(r.value);
  return p.success ? undefined : p.error.issues[0]?.message;
}

/** The image field's client check: a Docker reference, or empty (the factory default). */
function imageCheck(value: unknown): string | undefined {
  const r = readString(readAt(value, FIELD_PATHS.image));
  if (!r.ok || r.value === undefined || r.value === "") return undefined;
  const p = imageRefSchema.safeParse(r.value);
  return p.success ? undefined : p.error.issues[0]?.message;
}

/**
 * The form's shared state for its fields: the tolerant value, the inherited base, issues grouped by field once per
 * change (L2), and the field errors (L4). Sections (this task's Model; C3's others) read it with `useConfigScope`.
 */
export function ConfigFormScope({
  mode,
  value,
  base = null,
  templateName,
  onChange,
  readOnly = false,
  disabledReason,
  className = "grid min-w-0 gap-8",
  issues,
  conflicts,
  onShowRaw,
  children,
}: ConfigFormProps & { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const fieldErrors = useFieldErrors<ConfigField>({
    form: root,
    checks: {
      model: () => modelCheck(value),
      warmWindow: () => numberCheck(value, "warmWindow"),
      image: () => imageCheck(value),
    },
    fields: CONFIG_FIELDS,
  });

  const keep = mode === "template" ? keepDocParts : keepNothing;
  const update = useCallback(
    (path: readonly string[], next: (prev: unknown) => unknown) =>
      onChange((prev) => {
        const at = readAt(prev, path);
        return setAt(prev, path, next(at.ok ? at.value : undefined), keep);
      }),
    [onChange, keep],
  );

  // Issues change on a save or a validate, not a keystroke: group them once per change.
  const byField = useMemo(() => {
    const m = new Map<ConfigField, FieldIssues>();
    for (const i of issues) {
      const hit = i.path ? fieldForPath(i.path) : null;
      if (!hit) continue;
      const e = m.get(hit.field) ?? { items: new Map<string, RowNote>() };
      if (hit.item !== undefined) {
        // The first issue per item wins, except that an error replaces a warning.
        const had = e.items.get(hit.item);
        if (!had || (had.severity === "warning" && i.severity === "error"))
          e.items.set(hit.item, { message: i.message, severity: i.severity });
      } else if (i.severity === "error") e.error ??= i.message;
      else e.warning ??= i.message;
      m.set(hit.field, e);
    }
    return m;
  }, [issues]);

  const conflictFields = useMemo(
    () =>
      new Set(
        (conflicts ?? []).flatMap((p) => {
          const hit = fieldForPath(p);
          return hit ? [hit.field] : [];
        }),
      ),
    [conflicts],
  );

  const scope: ConfigScope = {
    mode,
    readOnly: readOnly || disabledReason !== undefined,
    disabledReason,
    value,
    base: mode === "agent" ? base : null,
    inheritedLabel: templateName ? `From template ${templateName}` : "From template",
    update,
    byField,
    conflicts: conflictFields,
    fieldErrors,
    onShowRaw,
  };
  return (
    <Scope value={scope}>
      <div ref={root} className={className}>
        {children}
      </div>
    </Scope>
  );
}

/** A field's note: a client check first, then a server issue, then a rebase conflict (a warning). */
export function useFieldNote(field: ConfigField): { error?: string; warning?: string } {
  const s = useConfigScope();
  const issue = s.byField.get(field);
  return {
    error: s.fieldErrors.errors[field] ?? issue?.error,
    warning: issue?.warning ?? (s.conflicts.has(field) ? CONFIG_FIELD_MSG.alsoChanged : undefined),
  };
}
