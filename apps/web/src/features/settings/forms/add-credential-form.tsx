import {
  ApiError,
  type AttemptView,
  type CredentialKind,
  type CredentialSummary,
  MSG,
  nameSchema,
} from "@open-factory/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { FieldShell } from "@/components/field-shell";
import { FormField } from "@/components/form-field";
import { useOutcome } from "@/components/forms/form-outcome";
import { useFieldErrors } from "@/components/forms/use-field-errors";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { createCredential } from "@/features/settings/api";
import { isLiveCreate, signInQueryOptions } from "@/features/settings/sign-in/api";
import { SignInPanel } from "@/features/settings/sign-in/sign-in-panel";
import { useSignIn } from "@/features/settings/sign-in/use-sign-in";
import { FORM_MSG } from "@/lib/form-messages.ts";
import { FormFrame, type FormFrameKind } from "./form-frame";
import { enterValueMessage, TokenField, valueNoun, verdictOf } from "./shared";

const cap = (s: string) => s[0]?.toUpperCase() + s.slice(1);
type Field = "name" | "value" | "code";
const FIELDS: readonly Field[] = ["name", "value", "code"];

/** How the credential is added (spec §8.1): UI state only; the first two store an `oauth_token`. */
type Method = "sign_in" | "paste_token" | "api_key";
type PasteMethod = Exclude<Method, "sign_in">;
const METHODS: readonly { value: Method; label: string }[] = [
  { value: "sign_in", label: "Sign in with Claude" },
  { value: "paste_token", label: "Paste a token" },
  { value: "api_key", label: "Paste an API key" },
];
const KIND_OF: Record<PasteMethod, CredentialKind> = {
  paste_token: "oauth_token",
  api_key: "api_key",
};
/** Module-level, so the `select` is stable and its result structurally shared. */
const formView = (d: { available: boolean; attempt: AttemptView | null }) => ({
  restoring: isLiveCreate(d),
  available: d.available,
});

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
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState<Method>();
  // Each paste method keeps its own value across switches.
  const [values, setValues] = useState<Record<PasteMethod, string>>({
    paste_token: "",
    api_key: "",
  });
  // A transient verification problem: described under the token but not invalid.
  const [warning, setWarning] = useState<string>();
  const o = useOutcome();
  const [pending, setPending] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  // `restoring` decides the mount focus; `available` the Method. Read here, before the checks that use the Method.
  const { data: view } = useQuery({ ...signInQueryOptions, select: formView });
  const restoring = view?.restoring ?? false;
  const available = view?.available ?? true;
  // Derived in render: unavailable sign-in falls back to Paste a token, so no footer shows a dead primary (R1).
  const method: Method =
    chosen === undefined || (chosen === "sign_in" && !available)
      ? available
        ? "sign_in"
        : "paste_token"
      : chosen;

  const f = useFieldErrors<Field>({
    form: formRef,
    fields: FIELDS,
    checks: {
      name: () => {
        const r = nameSchema.safeParse(name);
        if (!r.success) return r.error.issues[0]?.message;
        return existing.includes(name) ? FORM_MSG.nameTaken : undefined;
      },
      value: () =>
        method !== "sign_in" && values[method].trim() === ""
          ? enterValueMessage(KIND_OF[method])
          : undefined,
    },
  });
  const s = useSignIn({ purpose: "create", fields: f, outcome: o, onDone });
  const signingIn = method === "sign_in";
  const busy = signingIn && (s.phase === "exchanging" || s.phase === "verifying");

  async function paste(m: PasteMethod) {
    o.clear();
    setWarning(undefined);
    if (!f.submit(["name", "value"])) return;
    setPending(true);
    try {
      onDone(await createCredential({ name, kind: KIND_OF[m], value: values[m] }));
      // The server ended this caller's sign-in attempt (spec §5.4).
      void qc.invalidateQueries({ queryKey: signInQueryOptions.queryKey });
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

  function submit() {
    if (method !== "sign_in") return void paste(method);
    // R8: Start runs no field checks; Name is checked only at the code submit.
    if (s.phase !== "ready") return void s.start();
    if (f.submit(["name"])) void s.submit(name);
  }

  const submitLabel = !signingIn
    ? "Verify and add"
    : s.phase === "ready"
      ? "Sign in and add"
      : s.line?.tone === "error"
        ? "Start again"
        : "Start sign-in";
  const signInPending = signingIn && s.pendingLabel !== undefined;

  return (
    <FormFrame
      frame={frame}
      label="Add credential"
      onSubmit={submit}
      onCancel={onCancel}
      submitLabel={submitLabel}
      pendingLabel={signInPending ? (s.pendingLabel ?? "") : "Verifying…"}
      pending={pending || signInPending}
      outcome={o.outcome}
      // A restored attempt moves focus itself (to Open sign-in page), so the frame's mount focus stays off.
      autoFocus={!restoring}
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
        // readOnly, not disabled, so focus stays while the code is exchanged (spec §8.2).
        readOnly={busy}
        aria-disabled={busy || undefined}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        className="font-mono"
      />
      <FieldShell
        name="credential-method"
        label="Method"
        legend
        help={available ? undefined : MSG.signInUnavailable}
      >
        {() => (
          <RadioGroup
            name="credential-method"
            value={method}
            onValueChange={(v) => {
              setChosen(v as Method);
              setWarning(undefined);
              f.change("value");
            }}
            className="gap-1.5"
          >
            {METHODS.map((m) => (
              <label
                key={m.value}
                htmlFor={`credential-method-${m.value}`}
                className="flex items-center gap-2 text-sm has-disabled:text-muted-foreground"
              >
                <RadioGroupItem
                  id={`credential-method-${m.value}`}
                  value={m.value}
                  disabled={m.value === "sign_in" && !available}
                />
                {m.label}
              </label>
            ))}
          </RadioGroup>
        )}
      </FieldShell>
      {method === "sign_in" ? (
        <SignInPanel s={s} frame={frame} codeRef={codeRef} />
      ) : (
        <TokenField
          key={method}
          name="credential-value"
          label={cap(valueNoun(KIND_OF[method]))}
          value={values[method]}
          onChange={(v) => {
            setValues((old) => ({ ...old, [method]: v }));
            setWarning(undefined);
            f.change("value");
          }}
          onBlur={(e) => f.blur("value", e)}
          verdict={{ error: f.errors.value, warning }}
          kind={KIND_OF[method]}
        />
      )}
    </FormFrame>
  );
}
