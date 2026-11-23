import { ApiError, type SecretSummary, secretNameSchema } from "@open-factory/shared";
import { type ChangeEvent, useState } from "react";
import { FormField } from "@/components/form-field";
import { useOutcome } from "@/components/forms/form-outcome";
import { putSecret } from "@/features/settings/api";
import { FormFrame, type FormFrameKind } from "./form-frame";
import { ValueField } from "./shared";

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
  const [errors, setErrors] = useState<{ name?: string; value?: string }>({});
  const o = useOutcome();
  const [pending, setPending] = useState(false);

  const checkName = (n: string) => {
    const r = secretNameSchema.safeParse(n);
    if (!r.success) return r.error.issues[0]?.message;
    return existing.includes(n)
      ? `A secret named ${n} already exists. Use Update to change its value.`
      : undefined;
  };
  const checkValue = (v: string) => (v === "" ? "Enter a value." : undefined);
  const focus = (f: "name" | "value") => document.getElementById(`field-secret-${f}`)?.focus();

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
    setErrors((x) => ({ ...x, name: undefined }));
  };

  async function submit() {
    const found = { name: checkName(name), value: checkValue(value) };
    setErrors(found);
    o.clear();
    if (found.name || found.value) return focus(found.name ? "name" : "value");
    setPending(true);
    try {
      onDone(await putSecret(name, value));
    } catch (err) {
      if (!(err instanceof ApiError)) return o.fail("Couldn't add the secret. Try again.");
      // Server field errors land under their fields whatever the code; a reserved name is a
      // Name error even when the server sends no `fields`.
      const fields = (err.body.fields ?? {}) as Record<string, string | undefined>;
      if (err.code === "secret_name_reserved" && !fields.name) fields.name = err.message;
      if (fields.name || fields.value) {
        setErrors({ name: fields.name, value: fields.value });
        focus(fields.name ? "name" : "value");
      } else o.fail(err.message);
    } finally {
      setPending(false);
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
      autoFocusId={initialName ? "field-secret-value" : undefined}
      reveal={Boolean(initialName)}
    >
      <FormField
        name="secret-name"
        label="Name"
        help="Uppercase letters, numbers and underscores, like GH_TOKEN."
        error={errors.name}
        value={name}
        onChange={onName}
        onBlur={() => setErrors((x) => ({ ...x, name: checkName(name) }))}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        className="font-mono"
      />
      <ValueField
        name="secret-value"
        label="Value"
        value={value}
        error={errors.value}
        onChange={(v) => {
          setValue(v);
          setErrors((x) => ({ ...x, value: undefined }));
        }}
        onBlur={() => setErrors((x) => ({ ...x, value: checkValue(value) }))}
      />
    </FormFrame>
  );
}
