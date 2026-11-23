import { ApiError, type SecretSummary, secretNameSchema } from "@open-factory/shared";
import { type ChangeEvent, useRef, useState } from "react";
import { FormField } from "@/components/form-field";
import { useOutcome } from "@/components/forms/form-outcome";
import { useFieldErrors } from "@/components/forms/use-field-errors";
import { putSecret } from "@/features/settings/api";
import { FORM_MSG } from "@/lib/form-messages.ts";
import { FormFrame, type FormFrameKind } from "./form-frame";
import { ValueField } from "./shared";

type Field = "name" | "value";
const FIELDS: readonly Field[] = ["name", "value"];

export function AddSecretForm({
  frame,
  initialName,
  existing,
  onDone,
  onCancel,
}: {
  frame: FormFrameKind;
  initialName: string;
  existing: string[];
  onDone(s: SecretSummary): void;
  onCancel(): void;
}) {
  const [name, setName] = useState(initialName);
  const [value, setValue] = useState("");
  const o = useOutcome();
  const [pending, setPending] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const f = useFieldErrors({
    form: formRef,
    fields: FIELDS,
    checks: {
      name: () => {
        const r = secretNameSchema.safeParse(name);
        if (!r.success) return r.error.issues[0]?.message;
        return existing.includes(name) ? FORM_MSG.nameTaken : undefined;
      },
      value: () => (value === "" ? FORM_MSG.enterValue : undefined),
    },
  });

  // Uppercase as the user types, keeping the caret where it was: the DOM value is set first,
  // so React finds it already matching and leaves the selection alone.
  const onName = (e: ChangeEvent<HTMLInputElement>) => {
    const el = e.target;
    const up = el.value.toUpperCase();
    if (up !== el.value) {
      const { selectionStart: s, selectionEnd: t } = el;
      el.value = up;
      el.setSelectionRange(s, t);
    }
    setName(up);
    f.change("name");
  };

  async function submit() {
    o.clear();
    if (!f.submit()) return;
    setPending(true);
    try {
      onDone(await putSecret(name, value));
    } catch (err) {
      setPending(false);
      if (!(err instanceof ApiError)) return o.fail(FORM_MSG.addSecretFailed);
      // Server field errors land under their fields whatever the code; a reserved name is a
      // Name error even when the server sends no `fields`.
      const fields = { ...((err.body.fields ?? {}) as Record<string, string>) };
      if (err.code === "secret_name_reserved" && !fields.name) fields.name = err.message;
      if (!f.server(fields)) o.fail(err.message);
    }
  }

  return (
    <FormFrame
      frame={frame}
      label="Add secret"
      onSubmit={() => void submit()}
      onCancel={onCancel}
      submitLabel="Add secret"
      pendingLabel="Adding…"
      pending={pending}
      outcome={o.outcome}
      ref={formRef}
      autoFocusId={initialName ? "field-secret-value" : undefined}
      reveal={Boolean(initialName)}
    >
      <FormField
        name="secret-name"
        label="Name"
        help="Uppercase letters, numbers and underscores, like GH_TOKEN."
        error={f.errors.name}
        value={name}
        onChange={onName}
        onBlur={(e) => f.blur("name", e)}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        className="font-mono"
      />
      <ValueField
        name="secret-value"
        label="Value"
        value={value}
        error={f.errors.value}
        onChange={(v) => {
          setValue(v);
          f.change("value");
        }}
        onBlur={(e) => f.blur("value", e)}
      />
    </FormFrame>
  );
}
