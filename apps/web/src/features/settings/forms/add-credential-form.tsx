import {
  ApiError,
  type CredentialKind,
  type CredentialSummary,
  nameSchema,
} from "@open-factory/shared";
import { useRef, useState } from "react";
import { FieldShell } from "@/components/field-shell";
import { FormField } from "@/components/form-field";
import { useOutcome } from "@/components/forms/form-outcome";
import { useFieldErrors } from "@/components/forms/use-field-errors";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { createCredential } from "@/features/settings/api";
import { FORM_MSG } from "@/lib/form-messages.ts";
import { FormFrame, type FormFrameKind } from "./form-frame";
import { enterValueMessage, TokenField, valueNoun, verdictOf } from "./shared";

const cap = (s: string) => s[0]?.toUpperCase() + s.slice(1);
type Field = "name" | "value";
const FIELDS: readonly Field[] = ["name", "value"];

export function AddCredentialForm({
  frame,
  existing,
  onDone,
  onCancel,
}: {
  frame: FormFrameKind;
  existing: string[];
  onDone(c: CredentialSummary): void;
  onCancel(): void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<CredentialKind>("oauth_token");
  const [value, setValue] = useState("");
  // A transient verification problem: described under the token but not invalid.
  const [warning, setWarning] = useState<string>();
  const o = useOutcome();
  const [pending, setPending] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const f = useFieldErrors({
    form: formRef,
    fields: FIELDS,
    checks: {
      name: () => {
        const r = nameSchema.safeParse(name);
        if (!r.success) return r.error.issues[0]?.message;
        return existing.includes(name) ? FORM_MSG.nameTaken : undefined;
      },
      value: () => (value.trim() === "" ? enterValueMessage(kind) : undefined),
    },
  });

  async function submit() {
    o.clear();
    setWarning(undefined);
    if (!f.submit()) return;
    setPending(true);
    try {
      onDone(await createCredential({ name, kind, value }));
    } catch (err) {
      setPending(false);
      const v = verdictOf(err);
      if (v?.error) f.set("value", v.error, { focus: true });
      else if (v?.warning) {
        setWarning(v.warning);
        o.fail(FORM_MSG.addCredentialFailed);
      } else if (err instanceof ApiError && err.code === "credential_exists")
        f.set("name", FORM_MSG.nameTaken, { focus: true });
      else if (err instanceof ApiError && err.code === "validation_error") {
        const fields = (err.body.fields ?? {}) as Record<string, string>;
        if (!f.server(fields)) o.fail(err.message);
      } else o.fail(err instanceof ApiError ? err.message : FORM_MSG.addCredentialFailed);
    }
  }

  return (
    <FormFrame
      frame={frame}
      label="Add credential"
      onSubmit={() => void submit()}
      onCancel={onCancel}
      submitLabel="Verify and add"
      pendingLabel="Verifying…"
      pending={pending}
      outcome={o.outcome}
      ref={formRef}
    >
      <FormField
        name="credential-name"
        label="Name"
        error={f.errors.name}
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          f.change("name");
        }}
        onBlur={(e) => f.blur("name", e)}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        className="font-mono"
      />
      <FieldShell name="credential-kind" label="Kind" legend>
        {() => (
          <RadioGroup
            name="credential-kind"
            value={kind}
            onValueChange={(v) => {
              setKind(v as typeof kind);
              setWarning(undefined);
              f.change("value");
            }}
            className="gap-1.5"
          >
            {(["oauth_token", "api_key"] as const).map((k) => (
              <label
                key={k}
                htmlFor={`credential-kind-${k}`}
                className="flex items-center gap-2 text-sm"
              >
                <RadioGroupItem id={`credential-kind-${k}`} value={k} />
                {k === "oauth_token" ? (
                  <span>
                    OAuth token (from{" "}
                    <code className="font-mono text-[0.8125rem]">claude setup-token</code>)
                  </span>
                ) : (
                  "API key"
                )}
              </label>
            ))}
          </RadioGroup>
        )}
      </FieldShell>
      <TokenField
        name="credential-value"
        label={cap(valueNoun(kind))}
        value={value}
        onChange={(v) => {
          setValue(v);
          setWarning(undefined);
          f.change("value");
        }}
        onBlur={(e) => f.blur("value", e)}
        verdict={{ error: f.errors.value, warning }}
        kind={kind}
      />
    </FormFrame>
  );
}
