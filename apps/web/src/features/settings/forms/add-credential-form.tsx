import {
  ApiError,
  type CredentialKind,
  type CredentialSummary,
  nameSchema,
} from "@open-factory/shared";
import { useState } from "react";
import { FieldShell } from "@/components/field-shell";
import { FormField } from "@/components/form-field";
import { useOutcome } from "@/components/forms/form-outcome";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { createCredential } from "@/features/settings/api";
import { FormFrame, type FormFrameKind } from "./form-frame";
import { TokenField, type Verdict, valueNoun, verdictOf } from "./shared";

const cap = (s: string) => s[0]?.toUpperCase() + s.slice(1);

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
  const [nameError, setNameError] = useState<string>();
  const [verdict, setVerdict] = useState<Verdict>({});
  const o = useOutcome();
  const [pending, setPending] = useState(false);

  const checkName = (n: string) => {
    if (!nameSchema.safeParse(n).success) {
      return "Use 2–40 lowercase letters, numbers and inner hyphens, starting with a letter.";
    }
    return existing.includes(n) ? `A credential named ${n} already exists.` : undefined;
  };
  const checkValue = (v: string, k: CredentialKind) =>
    v.trim() === "" ? `Enter the ${valueNoun(k)}.` : undefined;
  const focus = (f: "name" | "value") => document.getElementById(`field-credential-${f}`)?.focus();

  async function submit() {
    const n = checkName(name);
    const v = checkValue(value, kind);
    setNameError(n);
    setVerdict(v ? { error: v } : {});
    o.clear();
    if (n || v) return focus(n ? "name" : "value");
    setPending(true);
    try {
      onDone(await createCredential({ name, kind, value }));
    } catch (err) {
      const verdictErr = verdictOf(err);
      if (verdictErr) {
        setVerdict(verdictErr);
        if (verdictErr.error) focus("value");
      } else if (err instanceof ApiError && err.code === "credential_exists") {
        setNameError(err.message);
        focus("name");
      } else if (err instanceof ApiError && err.code === "validation_error") {
        const fields = (err.body.fields ?? {}) as Record<string, string>;
        if (fields.name) setNameError(fields.name);
        if (fields.value) setVerdict({ error: fields.value });
        if (fields.name || fields.value) focus(fields.name ? "name" : "value");
        else o.fail(err.message);
      } else {
        o.fail(err instanceof ApiError ? err.message : "Couldn't add the credential. Try again.");
      }
    } finally {
      setPending(false);
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
    >
      <FormField
        name="credential-name"
        label="Name"
        error={nameError}
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setNameError(undefined);
        }}
        onBlur={() => setNameError(checkName(name))}
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
              setVerdict({});
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
          setVerdict({});
        }}
        onBlur={() => {
          const v = checkValue(value, kind);
          if (v) setVerdict({ error: v });
        }}
        verdict={verdict}
        kind={kind}
      />
    </FormFrame>
  );
}
