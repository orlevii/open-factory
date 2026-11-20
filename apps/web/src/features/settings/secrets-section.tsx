import { ApiError, type SecretSummary, secretNameSchema } from "@open-factory/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, Plus } from "lucide-react";
import { type ChangeEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ErrorLine } from "@/components/error-line";
import { FieldShell } from "@/components/field-shell";
import { FormField } from "@/components/form-field";
import { InlineOutcome } from "@/components/inline-outcome";
import { PasswordInput } from "@/components/password-input";
import { Button } from "@/components/ui/button";
import { deleteSecret, putSecret, secretsQueryOptions } from "@/features/settings/api";
import {
  focusOutcome,
  InlineForm,
  RowLine,
  RowName,
  restartNote,
  SettingsList,
  SettingsSection,
  smallClass,
  TimeAgo,
  tags,
  Usage,
  useFocusLater,
} from "@/features/settings/shared";

type Outcome = { tone: "success" | "error" | "pending"; content: ReactNode; focusKey?: number };

const withNote = (head: string, users: string[]) => `${head} ${restartNote(users)}`.trim();

function ValueField({
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

function AddSecretForm({
  initialName,
  existing,
  onDone,
  onCancel,
}: {
  initialName: string;
  existing: string[];
  onDone(s: SecretSummary): void;
  onCancel(): void;
}) {
  const [name, setName] = useState(initialName);
  const [value, setValue] = useState("");
  const [errors, setErrors] = useState<{ name?: string; value?: string }>({});
  const [formError, setFormError] = useState<string>();
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
    setFormError(undefined);
    if (found.name || found.value) return focus(found.name ? "name" : "value");
    setPending(true);
    try {
      onDone(await putSecret(name, value));
    } catch (err) {
      if (!(err instanceof ApiError)) return setFormError("Couldn't add the secret. Try again.");
      // Server field errors land under their fields whatever the code; a reserved name is a
      // Name error even when the server sends no `fields`.
      const fields = (err.body.fields ?? {}) as Record<string, string | undefined>;
      if (err.code === "secret_name_reserved" && !fields.name) fields.name = err.message;
      if (fields.name || fields.value) {
        setErrors({ name: fields.name, value: fields.value });
        focus(fields.name ? "name" : "value");
      } else setFormError(err.message);
    } finally {
      setPending(false);
    }
  }

  return (
    <InlineForm
      label="Add secret"
      onSubmit={() => void submit()}
      onCancel={onCancel}
      submitLabel="Add secret"
      pendingLabel="Adding…"
      pending={pending}
      formError={formError}
      autoFocusId={initialName ? "field-secret-value" : undefined}
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
    </InlineForm>
  );
}

function UpdateForm({
  secret,
  onDone,
  onCancel,
}: {
  secret: SecretSummary;
  onDone(s: SecretSummary): void;
  onCancel(): void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string>();
  const [formError, setFormError] = useState<string>();
  const [pending, setPending] = useState(false);
  const field = `secret-update-${secret.name}`;

  async function submit() {
    setFormError(undefined);
    if (value === "") {
      setError("Enter a value.");
      return document.getElementById(`field-${field}`)?.focus();
    }
    setPending(true);
    try {
      onDone(await putSecret(secret.name, value));
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Couldn't save the value. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <InlineForm
      label={`Update ${secret.name}`}
      onSubmit={() => void submit()}
      onCancel={onCancel}
      submitLabel="Save value"
      pendingLabel="Saving…"
      pending={pending}
      formError={formError}
    >
      <ValueField
        name={field}
        label="New value"
        value={value}
        error={error}
        onChange={(v) => {
          setValue(v);
          setError(undefined);
        }}
      />
    </InlineForm>
  );
}

function deleteBody(users: string[]) {
  if (users.length === 0) return "Its value is erased. No agent uses it.";
  const verb = users.length === 1 ? "restarts" : "restart";
  return `Its value is erased. ${tags(users)} ${verb} when idle without it and won't start until you add it again.`;
}

export function SecretsSection({ addSecret }: { addSecret?: string }) {
  const qc = useQueryClient();
  const query = useQuery(secretsQueryOptions);
  const { data } = query;
  const focusLater = useFocusLater();
  const [adding, setAdding] = useState(Boolean(addSecret));
  const [prefill, setPrefill] = useState((addSecret ?? "").toUpperCase());
  const [outcome, setOutcome] = useState<Outcome>();
  const [rowOutcome, setRowOutcome] = useState<Record<string, Outcome>>({});
  const [updating, setUpdating] = useState<string>();
  const [confirming, setConfirming] = useState<SecretSummary>();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const deleted = useRef(false);

  // A later link to ?addSecret=NAME (while already here) opens the form with that name.
  const seen = useRef(addSecret);
  useEffect(() => {
    if (!addSecret || addSecret === seen.current) return;
    seen.current = addSecret;
    setPrefill(addSecret.toUpperCase());
    setAdding(true);
  }, [addSecret]);

  const refresh = () => qc.invalidateQueries({ queryKey: secretsQueryOptions.queryKey });
  const upsert = (s: SecretSummary) =>
    qc.setQueryData(secretsQueryOptions.queryKey, (old) =>
      old?.some((x) => x.name === s.name)
        ? old.map((x) => (x.name === s.name ? s : x))
        : [...(old ?? []), s].sort((a, b) => a.name.localeCompare(b.name)),
    );
  const setRow = (name: string, o: Outcome | undefined) =>
    setRowOutcome((x) => {
      const next = { ...x };
      if (o) next[name] = o;
      else delete next[name];
      return next;
    });

  async function remove(s: SecretSummary) {
    await deleteSecret(s.name);
    qc.setQueryData(secretsQueryOptions.queryKey, (old) => old?.filter((x) => x.name !== s.name));
    deleted.current = true;
    setOutcome({ tone: "success", content: `Deleted ${s.name}.` });
    void refresh();
  }

  const secrets = data ?? [];
  return (
    <SettingsSection
      id="secrets"
      title="Secrets"
      description="Environment variables agents receive when their template lists them. Values can't be viewed after saving."
    >
      {!data && query.isError && (
        <ErrorLine text="Couldn't load secrets." onRetry={() => void query.refetch()} />
      )}
      {data &&
        (secrets.length === 0 ? (
          <p className="text-sm text-muted-foreground">No secrets yet.</p>
        ) : (
          <SettingsList>
            {secrets.map((s) => (
              <li
                key={s.name}
                data-name={s.name}
                className="grid grid-cols-[minmax(0,1fr)] gap-1 px-2 py-1.5"
              >
                <RowLine
                  actions={
                    <>
                      <Button
                        id={`secret-update-button-${s.name}`}
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setRow(s.name, undefined);
                          setUpdating(s.name);
                        }}
                      >
                        Update
                      </Button>
                      <Button
                        id={`secret-delete-button-${s.name}`}
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          deleted.current = false;
                          setConfirming(s);
                          setConfirmOpen(true);
                        }}
                      >
                        Delete…
                      </Button>
                    </>
                  }
                >
                  <RowName>{s.name}</RowName>
                  <span className={`flex items-center gap-1.5 ${smallClass} md:w-56 md:shrink-0`}>
                    <CircleCheck aria-hidden="true" className="size-3.5 shrink-0 text-success" />
                    Set
                    <span className="text-muted-foreground">
                      · updated <TimeAgo iso={s.updatedAt} />
                    </span>
                  </span>
                  <Usage active={s.usedBy} verb="Used by" none="Not used" />
                </RowLine>
                <InlineOutcome
                  tone={rowOutcome[s.name]?.tone}
                  focusKey={rowOutcome[s.name]?.focusKey}
                >
                  {rowOutcome[s.name]?.content}
                </InlineOutcome>
                {updating === s.name && (
                  <UpdateForm
                    secret={s}
                    onCancel={() => {
                      setUpdating(undefined);
                      focusLater(`secret-update-button-${s.name}`);
                    }}
                    onDone={(r) => {
                      upsert(r);
                      setUpdating(undefined);
                      setRow(s.name, {
                        tone: "success",
                        content: withNote("Saved.", r.usedBy),
                        focusKey: Date.now(),
                      });
                      void refresh();
                    }}
                  />
                )}
              </li>
            ))}
          </SettingsList>
        ))}
      {/* Empty, it takes no space; it stays mounted so its text is announced. */}
      <div id="secrets-outcome" className="[&:not(:has([tabindex]))]:-mt-3">
        <InlineOutcome tone={outcome?.tone} focusKey={outcome?.focusKey}>
          {outcome?.content}
        </InlineOutcome>
      </div>
      {/* Only once the list is loaded: the add is an upsert, so without the list an existing
          name would be silently overwritten instead of refused on the Name field. */}
      {!data ? null : adding ? (
        <AddSecretForm
          // A later ?addSecret remounts the open form with the new name and refocuses Value.
          key={prefill}
          initialName={prefill}
          existing={secrets.map((s) => s.name)}
          onCancel={() => {
            setAdding(false);
            setPrefill("");
            focusLater("secrets-add");
          }}
          onDone={(s) => {
            upsert(s);
            setAdding(false);
            setPrefill("");
            setOutcome({
              tone: "success",
              content: withNote(`Added ${s.name}.`, s.usedBy),
              focusKey: Date.now(),
            });
            void refresh();
          }}
        />
      ) : (
        <div>
          <Button
            id="secrets-add"
            type="button"
            variant="ghost"
            onClick={() => {
              setOutcome(undefined);
              setAdding(true);
            }}
          >
            <Plus aria-hidden="true" data-icon="inline-start" />
            Add secret
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Delete secret ${confirming?.name ?? ""}?`}
        body={deleteBody(confirming?.usedBy ?? [])}
        confirmLabel={`Delete ${confirming?.name ?? ""}`}
        onConfirm={() => (confirming ? remove(confirming) : undefined)}
        onCloseAutoFocus={(e) => {
          // No Radix trigger to return to: back to Delete…, or, after a delete (the row is gone),
          // to the outcome line.
          e.preventDefault();
          if (deleted.current) focusOutcome("secrets-outcome");
          else if (confirming)
            document.getElementById(`secret-delete-button-${confirming.name}`)?.focus();
        }}
      />
    </SettingsSection>
  );
}
