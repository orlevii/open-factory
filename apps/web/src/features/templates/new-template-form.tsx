import {
  ApiError,
  createTemplateBodySchema,
  isReservedTemplateName,
  RESERVED_TEMPLATE_NAME_MESSAGE,
  RESERVED_TEMPLATE_NAMES,
} from "@open-factory/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { FieldShell } from "@/components/field-shell";
import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { notify } from "@/components/ui/toaster";
import { deriveSlug } from "@/features/agents/derive-slug";
import { FormFrame, type FormFrameKind } from "@/features/settings/forms/form-frame";
import { clearDraft, useSheetDraft } from "@/features/sheets/drafts";
import type { BodyProps } from "@/features/sheets/sheet-bodies";
import {
  closeChildSheet,
  closeSheet,
  completeChild,
  getSheetState,
  openSheet,
} from "@/features/sheets/sheet-store";
import { createTemplate, templatesQueryOptions } from "./api";

type Field = "name" | "displayName" | "description";
type Errors = Partial<Record<Field, string>>;
type Values = { displayName: string; name: string; revealed: boolean; description: string };
const blank = (): Values => ({ displayName: "", name: "", revealed: false, description: "" });

const NAME_HELP = "Lowercase letters, numbers and hyphens. Also the folder name.";
const MESSAGES: Record<Field, string> = {
  name: "Use lowercase letters, numbers and hyphens, starting with a letter (2 to 40 characters).",
  displayName: "Enter a display name (up to 80 characters).",
  description: "Keep the description under 500 characters.",
};
const ORDER: readonly Field[] = ["displayName", "name", "description"];

function check(field: Field, v: { displayName: string; name: string; description: string }) {
  if (field === "displayName" && v.displayName.trim() === "") return "Enter a display name.";
  const r = createTemplateBodySchema.shape[field].safeParse(
    field === "description" && v.description.trim() === "" ? undefined : v[field],
  );
  if (r.success) return undefined;
  return field === "name" && isReservedTemplateName(v.name)
    ? RESERVED_TEMPLATE_NAME_MESSAGE
    : MESSAGES[field];
}

/**
 * The New template form (§7.4), identity first: Display name, the folder line (derived from it, Change reveals Name),
 * Description. `then: "open-editor"` keeps a draft for the tab; the stacked `return` keeps none. `onDone` gets the
 * created name. A result that arrives when `stillOpen()` is false goes to `onDone` on success and `onLateError` on
 * failure, never to the form.
 */
export function NewTemplateForm({
  frame,
  then,
  onDone,
  onCancel,
  stillOpen = () => true,
  onLateError,
}: {
  frame: FormFrameKind;
  then: "open-editor" | "return";
  onDone(name: string): void;
  onCancel(): void;
  stillOpen?(): boolean;
  onLateError?(message: string): void;
}) {
  const stacked = then === "return";
  const draft = useSheetDraft<Values>("new-template", blank);
  const [v, setV] = useState<Values>(() => (stacked ? blank() : draft.start));
  const [restored, setRestored] = useState(!stacked && draft.restored);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string>();
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const form = useRef<HTMLDivElement>(null);
  const templates = useQuery(templatesQueryOptions);
  const taken = useMemo(
    () =>
      new Set([
        ...(templates.data?.templates.map((t) => t.name) ?? []),
        ...RESERVED_TEMPLATE_NAMES,
      ]),
    [templates.data],
  );
  const qc = useQueryClient();

  const derived = useMemo(() => deriveSlug(v.displayName, taken), [v.displayName, taken]);
  const name = v.revealed ? v.name : derived;
  // The reserved names are in `taken`, so "Images" derives images-2: only a hand-typed one is reserved.

  // The latest values, so two updates in one event never build on a stale closure.
  const latest = useRef(v);
  const update = (patch: Partial<Values>) => {
    const next = { ...latest.current, ...patch };
    latest.current = next;
    setV(next);
    if (!stacked) draft.save(next);
  };
  const setError = (f: Field, m: string | undefined) => setErrors((e) => ({ ...e, [f]: m }));
  const focus = (f: Field) => form.current?.querySelector<HTMLElement>(`#field-${f}`)?.focus();
  /** Rendered before focusing: Name only exists once revealed. */
  const show = (e: Errors) => {
    flushSync(() => {
      setErrors(e);
      if (e.name && !latest.current.revealed) update({ name, revealed: true });
    });
    const first = ORDER.find((f) => e[f]);
    if (first) focus(first);
  };

  async function submit() {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      setFormError(undefined);
      const values = { ...v, name };
      const found: Errors = {};
      for (const f of ORDER) {
        // Name stays folded unless the display name is there but yields no folder ("!!!"): an empty display
        // name is its own error, not a reason to open Name.
        const m =
          f === "name" && !v.revealed
            ? v.displayName.trim() !== "" && !name
              ? MESSAGES.name
              : name
                ? check(f, values)
                : undefined
            : check(f, values);
        if (m) found[f] = m;
      }
      show(found);
      if (ORDER.some((f) => found[f])) return;
      setPending(true);
      try {
        const t = await createTemplate({
          name,
          displayName: v.displayName.trim(),
          description: v.description.trim() || undefined,
        });
        void qc.invalidateQueries({ queryKey: ["templates"] });
        onDone(t.name);
      } catch (err) {
        const message =
          err instanceof ApiError ? err.message : "Couldn't create the template. Try again.";
        if (!stillOpen()) return onLateError?.(message);
        if (err instanceof ApiError && err.code === "template_exists") {
          show({ name: err.message });
        } else if (err instanceof ApiError && err.code === "validation_error") {
          const fields = (err.body.fields ?? {}) as Record<string, string>;
          const e: Errors = {};
          for (const f of ORDER) if (fields[f]) e[f] = fields[f];
          if (ORDER.some((f) => e[f])) show(e);
          else setFormError(message);
        } else setFormError(message);
      } finally {
        setPending(false);
      }
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <FormFrame
      frame={frame}
      label="New template"
      onSubmit={() => void submit()}
      onCancel={onCancel}
      submitLabel="Create template"
      pendingLabel="Creating…"
      pending={pending}
      formError={formError}
      left={
        restored && (
          <span className="inline-flex items-center">
            Draft restored ·
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                draft.clear();
                latest.current = blank();
                setV(latest.current);
                setErrors({});
                setRestored(false);
              }}
            >
              Discard
            </Button>
          </span>
        )
      }
    >
      <div ref={form} className="grid gap-4">
        <FormField
          name="displayName"
          label="Display name"
          error={errors.displayName}
          value={v.displayName}
          onChange={(e) => {
            update({ displayName: e.target.value });
            setError("displayName", undefined);
          }}
          onBlur={() => setError("displayName", check("displayName", { ...v, name }))}
          autoComplete="off"
        />
        {v.revealed ? (
          <FormField
            name="name"
            label="Name"
            help={NAME_HELP}
            error={errors.name}
            value={v.name}
            onChange={(e) => {
              update({ name: e.target.value });
              setError("name", undefined);
            }}
            onBlur={() => setError("name", check("name", { ...v, name: v.name }))}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            className="font-mono"
          />
        ) : (
          <p className="flex flex-wrap items-center gap-x-1.5 text-[0.8125rem] text-muted-foreground">
            Folder <code className="font-mono text-foreground">templates/{name || "…"}</code> ·
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => update({ revealed: true, name })}
            >
              Change
            </Button>
          </p>
        )}
        <FieldShell name="description" label="Description (optional)" error={errors.description}>
          {(a) => (
            <Textarea
              id={a.id}
              name="description"
              rows={3}
              aria-invalid={a.invalid || undefined}
              aria-describedby={a.describedBy}
              value={v.description}
              onChange={(e) => {
                update({ description: e.target.value });
                setError("description", undefined);
              }}
              onBlur={() => setError("description", check("description", { ...v, name }))}
            />
          )}
        </FieldShell>
      </div>
    </FormFrame>
  );
}

type Spec = { kind: "new-template"; then: "open-editor" | "return" };

/** The New template sheet body (§7.4). Dismissed before the result: a toast, never a navigation (D19). */
export default function NewTemplateSheet({ spec, sheetId, close }: BodyProps<Spec>) {
  const router = useRouter();
  const stacked = spec.then === "return";
  const stillOpen = () =>
    stacked ? getSheetState().child?.id === sheetId : getSheetState().parent?.id === sheetId;
  return (
    <NewTemplateForm
      frame="sheet"
      then={spec.then}
      onCancel={close}
      stillOpen={stillOpen}
      onLateError={(text) =>
        notify({
          text,
          action: stacked
            ? undefined
            : {
                label: "Open form",
                // biome-ignore lint/suspicious/noThenProperty: SheetSpec's field, not a thenable
                run: () => openSheet({ kind: "new-template", then: "open-editor" }),
              },
        })
      }
      onDone={(name) => {
        if (stacked) {
          if (stillOpen()) {
            completeChild(sheetId, name);
            closeChildSheet();
          } else notify({ text: `Created ${name}.` });
          return;
        }
        const open = stillOpen();
        // A late success must not wipe a draft the user restored by reopening New template meanwhile.
        if (getSheetState().parent?.kind !== "new-template" || open) clearDraft("new-template");
        if (open) {
          closeSheet();
          void router.navigate({ to: "/templates/$name", params: { name } });
        } else {
          notify({
            text: `Created ${name}.`,
            action: {
              label: "Open",
              run: () => void router.navigate({ to: "/templates/$name", params: { name } }),
            },
          });
        }
      }}
    />
  );
}
