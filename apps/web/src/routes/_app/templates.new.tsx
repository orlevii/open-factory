import { ApiError, createTemplateBodySchema } from "@open-factory/shared";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { FieldShell } from "@/components/field-shell";
import { FormField } from "@/components/form-field";
import { PageBody, PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { createTemplate } from "@/features/templates/api";

export const Route = createFileRoute("/_app/templates/new")({ component: NewTemplate });

type Field = "name" | "displayName" | "description";
type Errors = Partial<Record<Field, string>>;

const MESSAGES: Record<Field, string> = {
  name: "Use lowercase letters, numbers and hyphens, starting with a letter (2 to 40 characters).",
  displayName: "Enter a display name (up to 80 characters).",
  description: "Keep the description under 500 characters.",
};

function check(field: Field, v: Record<Field, string>): string | undefined {
  if (field === "displayName" && v.displayName.trim() === "") return "Enter a display name.";
  const r = createTemplateBodySchema.shape[field].safeParse(
    field === "description" && v.description.trim() === "" ? undefined : v[field],
  );
  return r.success ? undefined : MESSAGES[field];
}

function NewTemplate() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [values, setValues] = useState<Record<Field, string>>({
    name: "",
    displayName: "",
    description: "",
  });
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string>();
  const [pending, setPending] = useState(false);
  const form = useRef<HTMLFormElement>(null);

  const set = (f: Field, v: string) => {
    setValues((s) => ({ ...s, [f]: v }));
    setErrors((e) => ({ ...e, [f]: undefined }));
  };
  const blur = (f: Field) => setErrors((e) => ({ ...e, [f]: check(f, values) }));
  const focusFirst = (e: Errors) => {
    const first = (["name", "displayName", "description"] as const).find((f) => e[f]);
    if (first) form.current?.querySelector<HTMLElement>(`#field-${first}`)?.focus();
  };

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    if (pending) return;
    const found: Errors = {};
    for (const f of ["name", "displayName", "description"] as const) {
      const m = check(f, values);
      if (m) found[f] = m;
    }
    setErrors(found);
    setFormError(undefined);
    if (Object.keys(found).length > 0) return focusFirst(found);
    setPending(true);
    try {
      const t = await createTemplate({
        name: values.name,
        displayName: values.displayName.trim(),
        description: values.description.trim() || undefined,
      });
      await qc.invalidateQueries({ queryKey: ["templates"] });
      await navigate({ to: "/templates/$name", params: { name: t.name } });
    } catch (err) {
      if (err instanceof ApiError && err.code === "template_exists") {
        const e = { name: err.message };
        setErrors(e);
        focusFirst(e);
      } else if (err instanceof ApiError && err.code === "validation_error") {
        const fields = (err.body.fields ?? {}) as Record<string, string>;
        const e: Errors = {};
        for (const f of ["name", "displayName", "description"] as const) {
          if (fields[f]) e[f] = fields[f];
        }
        if (Object.keys(e).length > 0) {
          setErrors(e);
          focusFirst(e);
        } else setFormError(err.message);
      } else {
        setFormError(
          err instanceof ApiError ? err.message : "Couldn't create the template. Try again.",
        );
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <PageHeader title="New template" documentTitle="New template" />
      <PageBody>
        <form ref={form} onSubmit={submit} noValidate className="grid max-w-xl gap-5">
          <FormField
            name="name"
            label="Name"
            help="Lowercase letters, numbers and hyphens. Also the folder name."
            error={errors.name}
            value={values.name}
            onChange={(e) => set("name", e.target.value)}
            onBlur={() => blur("name")}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            className="font-mono"
          />
          <FormField
            name="displayName"
            label="Display name"
            error={errors.displayName}
            value={values.displayName}
            onChange={(e) => set("displayName", e.target.value)}
            onBlur={() => blur("displayName")}
            autoComplete="off"
          />
          <FieldShell name="description" label="Description (optional)" error={errors.description}>
            {(a) => (
              <Textarea
                id={a.id}
                name="description"
                rows={3}
                aria-invalid={a.invalid || undefined}
                aria-describedby={a.describedBy}
                value={values.description}
                onChange={(e) => set("description", e.target.value)}
                onBlur={() => blur("description")}
              />
            )}
          </FieldShell>
          <div className="grid gap-2">
            <div
              role="alert"
              className="text-[0.8125rem] leading-[1.125rem] text-destructive empty:hidden"
            >
              {formError}
            </div>
            <div>
              <Button type="submit" size="lg" aria-disabled={pending || undefined}>
                {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
                {pending ? "Creating…" : "Create template"}
              </Button>
              <span role="status" className="sr-only">
                {pending ? "Creating template…" : ""}
              </span>
            </div>
          </div>
        </form>
      </PageBody>
    </>
  );
}
