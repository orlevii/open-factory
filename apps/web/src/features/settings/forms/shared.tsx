import { ApiError, type CredentialKind } from "@open-factory/shared";
import { TriangleAlert } from "lucide-react";
import { FieldShell } from "@/components/field-shell";
import { PasswordInput } from "@/components/password-input";
import { CodeText, smallClass } from "@/features/settings/shared";

/** Field pieces and checks shared by the Add forms and the Replace, Update and Change path forms. */

export const valueNoun = (k: CredentialKind) => (k === "oauth_token" ? "token" : "key");
/** A transient verification failure: the token may be fine, so it isn't marked invalid. */
function Unverifiable({ id, message }: { id: string; message?: string }) {
  return (
    <div role="alert">
      {message && (
        <p id={id} className={`flex items-start gap-1.5 ${smallClass}`}>
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-warning" />
          {message}
        </p>
      )}
    </div>
  );
}

export type Verdict = { error?: string; warning?: string };
/** 422s from a verification turn: a rejection is the token's fault, the rest is transient. */
export function verdictOf(err: unknown): Verdict | undefined {
  if (!(err instanceof ApiError)) return undefined;
  if (err.code === "credential_rejected") return { error: err.message };
  if (err.code === "credential_unverifiable") return { warning: err.message };
  return undefined;
}

export function TokenField({
  name,
  label,
  value,
  onChange,
  onBlur,
  verdict,
}: {
  name: string;
  label: string;
  value: string;
  onChange(v: string): void;
  onBlur?(): void;
  verdict: Verdict;
}) {
  const warnId = `field-${name}-warning`;
  return (
    <div className="grid gap-1.5">
      <FieldShell
        name={name}
        label={label}
        error={verdict.error && <CodeText text={verdict.error} />}
      >
        {(a) => (
          <PasswordInput
            id={a.id}
            name={name}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onBlur={onBlur}
            spellCheck={false}
            aria-invalid={a.invalid || undefined}
            aria-describedby={
              [a.describedBy, verdict.warning && warnId].filter(Boolean).join(" ") || undefined
            }
          />
        )}
      </FieldShell>
      <Unverifiable id={warnId} message={verdict.warning} />
    </div>
  );
}

export function ValueField({
  name,
  label,
  value,
  error,
  onChange,
  onBlur,
}: {
  name: string;
  label: string;
  value: string;
  error?: string;
  onChange(v: string): void;
  onBlur?(): void;
}) {
  return (
    <FieldShell name={name} label={label} error={error}>
      {(a) => (
        <PasswordInput
          id={a.id}
          name={name}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          spellCheck={false}
          aria-invalid={a.invalid || undefined}
          aria-describedby={a.describedBy}
        />
      )}
    </FieldShell>
  );
}

export const PATH_HELP = "Absolute path to a folder on this machine, usually a git repository.";
export const checkPath = (p: string) =>
  p.trim() === ""
    ? "Enter a path."
    : p.trim().startsWith("/")
      ? undefined
      : "Enter an absolute path.";

/** Server field errors (`400 validation_error` with `fields`) for this form's fields. */
export const fieldsOf = (err: unknown): Record<string, string> | undefined =>
  err instanceof ApiError && err.code === "validation_error"
    ? ((err.body.fields ?? {}) as Record<string, string>)
    : undefined;
