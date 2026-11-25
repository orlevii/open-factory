import { ApiError, type CredentialKind } from "@open-factory/shared";
import type { FocusEvent } from "react";
import { FieldShell } from "@/components/field-shell";
import { PasswordInput } from "@/components/password-input";
import { FORM_MSG } from "@/lib/form-messages.ts";

/** Field pieces and checks shared by the Add forms and the Replace, Update and Change path forms. */

export const valueNoun = (k: CredentialKind) => (k === "oauth_token" ? "token" : "key");
/** Per-noun constants, so the copy stays in FORM_MSG (spec §8) rather than interpolated. */
export const enterValueMessage = (k: CredentialKind) =>
  k === "oauth_token" ? FORM_MSG.enterToken : FORM_MSG.enterKey;
export const replaceFailedMessage = (k: CredentialKind) =>
  k === "oauth_token" ? FORM_MSG.replaceTokenFailed : FORM_MSG.replaceKeyFailed;
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
  kind,
}: {
  name: string;
  label: string;
  value: string;
  onChange(v: string): void;
  onBlur?(e: FocusEvent<HTMLInputElement>): void;
  verdict: Verdict;
  kind?: CredentialKind;
}) {
  return (
    <FieldShell
      name={name}
      label={label}
      error={verdict.error}
      warning={verdict.warning}
      help={kind === "oauth_token" ? "Create one with `claude setup-token`." : undefined}
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
          aria-describedby={a.describedBy}
        />
      )}
    </FieldShell>
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
  onBlur?(e: FocusEvent<HTMLInputElement>): void;
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
    ? FORM_MSG.enterPath
    : p.trim().startsWith("/")
      ? undefined
      : FORM_MSG.absolutePath;

/** Server field errors (`400 validation_error` with `fields`) for this form's fields. */
export const fieldsOf = (err: unknown): Record<string, string> | undefined =>
  err instanceof ApiError && err.code === "validation_error"
    ? ((err.body.fields ?? {}) as Record<string, string>)
    : undefined;
