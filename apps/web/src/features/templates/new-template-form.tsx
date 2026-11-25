import {
  ApiError,
  createTemplateBodySchema,
  RESERVED_TEMPLATE_NAMES,
  type TemplateDetail,
  type templatesListSchema,
} from "@open-factory/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import type { z } from "zod";
import { FieldShell } from "@/components/field-shell";
import { FormField } from "@/components/form-field";
import { useOutcome } from "@/components/forms/form-outcome";
import { useFieldErrors } from "@/components/forms/use-field-errors";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { notify } from "@/components/ui/toaster";
import { deriveSlug } from "@/features/agents/derive-slug";
import { FormFrame, type FormFrameKind } from "@/features/settings/forms/form-frame";
import { setupQueryOptions } from "@/features/setup/api";
import { refreshList, withItem, writeToList } from "@/features/sheets/add-to-list";
import {
  clearDraft,
  clearDraftIf,
  draftGeneration,
  peekDraft,
  useSheetDraft,
} from "@/features/sheets/drafts";
import type { BodyProps } from "@/features/sheets/sheet-bodies";
import {
  closeChildSheet,
  closeSheet,
  completeChild,
  getSheetState,
  openSheet,
} from "@/features/sheets/sheet-store";
import { FORM_MSG } from "@/lib/form-messages.ts";
import { createTemplate, templatesQueryOptions } from "./api";

type Field = "name" | "displayName" | "description";
type Values = { displayName: string; name: string; revealed: boolean; description: string };
const blank = (): Values => ({ displayName: "", name: "", revealed: false, description: "" });

const NAME_HELP = "Lowercase letters, numbers and hyphens. Also the folder name.";
const MESSAGES: Record<Exclude<Field, "name">, string> = {
  displayName: FORM_MSG.displayNameRequired,
  description: FORM_MSG.descriptionLength,
};
const FIELDS: readonly Field[] = ["displayName", "name", "description"];

type TemplateList = z.infer<typeof templatesListSchema>;
/** The list's row for a template just created (it has no agents yet). */
const summaryOf = (t: TemplateDetail): TemplateList["templates"][number] => ({
  name: t.name,
  displayName: t.config?.displayName,
  description: t.config?.description,
  runtime: t.config?.runtime,
  errors: t.issues.filter((i) => i.severity === "error").length,
  warnings: t.issues.filter((i) => i.severity === "warning").length,
  agentCount: 0,
});

function check(field: Field, v: { displayName: string; name: string; description: string }) {
  if (field === "displayName" && v.displayName.trim() === "") return FORM_MSG.enterDisplayName;
  const r = createTemplateBodySchema.shape[field].safeParse(
    field === "description" && v.description.trim() === "" ? undefined : v[field],
  );
  if (r.success) return undefined;
  // Name: the shared schema's first rule (spec §8), the same per-rule copy as credential and project names.
  return field === "name" ? r.error.issues[0]?.message : MESSAGES[field];
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
  /** `snapshot` is the draft as it was at submit (`peekDraft`), for judging a late success. */
  onDone(name: string, snapshot: unknown): void;
  onCancel(): void;
  stillOpen?(): boolean;
  onLateError?(message: string): void;
}) {
  const stacked = then === "return";
  const draft = useSheetDraft<Values>("new-template", blank);
  const [v, setV] = useState<Values>(() => (stacked ? blank() : draft.start));
  const [restored, setRestored] = useState(!stacked && draft.restored);
  const o = useOutcome();
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const form = useRef<HTMLFormElement>(null);
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
  const reveal = () => {
    if (!latest.current.revealed) update({ revealed: true, name });
  };

  // Name stays folded unless the display name is there but yields no folder ("!!!"): an empty display name is its
  // own error, not a reason to open Name.
  const checks = {
    displayName: () => check("displayName", { ...v, name }),
    name: () =>
      !v.revealed && !name
        ? v.displayName.trim() !== ""
          ? check("name", { ...v, name: "" })
          : undefined
        : check("name", { ...v, name }),
    description: () => check("description", { ...v, name }),
  };
  const f = useFieldErrors<Field>({ form, fields: FIELDS, checks });

  async function submit() {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      o.clear();
      // Name only exists once revealed; the reveal and f.submit share a commit, so focus finds it.
      if (checks.name() && !v.revealed) reveal();
      if (!f.submit()) return;
      setPending(true);
      // A sign-out while creating drops the result: it belongs to the old session.
      const generation = draftGeneration();
      const snapshot = stacked ? undefined : peekDraft("new-template");
      try {
        const t = await createTemplate({
          name,
          displayName: v.displayName.trim(),
          description: v.description.trim() || undefined,
        });
        if (draftGeneration() !== generation) return;
        void qc.invalidateQueries({ queryKey: setupQueryOptions.queryKey });
        // In the list before the parent's Template takes it (§7), then refetched in the background.
        const listKey = templatesQueryOptions.queryKey;
        await writeToList<TemplateList>(qc, listKey, (old) => ({
          ...old,
          templates: withItem(summaryOf(t))(old.templates),
        }));
        if (draftGeneration() !== generation) return;
        onDone(t.name, snapshot);
        refreshList(qc, listKey);
      } catch (err) {
        const message =
          err instanceof ApiError ? err.message : "Couldn't create the template. Try again.";
        if (!stillOpen()) {
          if (draftGeneration() === generation) onLateError?.(message);
          return;
        }
        const fields: Record<string, string> =
          err instanceof ApiError && err.code === "template_exists"
            ? { name: FORM_MSG.nameTaken }
            : err instanceof ApiError && err.code === "validation_error"
              ? ((err.body.fields ?? {}) as Record<string, string>)
              : {};
        // Name exists at the commit that focuses it, and the form is enabled in that same commit.
        if (fields.name) reveal();
        setPending(false);
        if (!f.server(fields)) o.fail(message);
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
      outcome={o.outcome}
      ref={form}
      left={
        restored && (
          <span className="inline-flex items-center">
            Draft restored ·
            <Button
              type="button"
              variant="ghost"
              size="sm"
              inForm
              data-skip-validate
              onClick={() => {
                draft.clear();
                latest.current = blank();
                setV(latest.current);
                f.reset();
                o.clear();
                setRestored(false);
              }}
            >
              Discard
            </Button>
          </span>
        )
      }
    >
      <FormField
        name="template-displayName"
        label="Display name"
        error={f.errors.displayName}
        value={v.displayName}
        onChange={(e) => {
          update({ displayName: e.target.value });
          f.change("displayName");
        }}
        onBlur={(e) => f.blur("displayName", e)}
        autoComplete="off"
      />
      {v.revealed ? (
        <FormField
          name="template-name"
          label="Name"
          help={NAME_HELP}
          error={f.errors.name}
          value={v.name}
          onChange={(e) => {
            update({ name: e.target.value });
            f.change("name");
          }}
          onBlur={(e) => f.blur("name", e)}
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
            inForm
            data-skip-validate
            onClick={() => update({ revealed: true, name })}
          >
            Change
          </Button>
        </p>
      )}
      <FieldShell
        name="template-description"
        label="Description (optional)"
        error={f.errors.description}
      >
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
              f.change("description");
            }}
            onBlur={(e) => f.blur("description", e)}
          />
        )}
      </FieldShell>
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
      onDone={(name, snapshot) => {
        if (stacked) {
          if (stillOpen()) {
            completeChild(sheetId, name);
            closeChildSheet();
          } else notify({ text: `Created ${name}.` });
          return;
        }
        const open = stillOpen();
        // A late success clears the draft only if it still holds the submitted values; a New template reopened on
        // those untouched values closes, so the same template can't be created twice. Edits made since are kept.
        if (open) clearDraft("new-template");
        else if (
          clearDraftIf("new-template", snapshot) &&
          getSheetState().parent?.kind === "new-template" &&
          !getSheetState().child
        )
          closeSheet();
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
