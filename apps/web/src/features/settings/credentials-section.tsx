import {
  ApiError,
  type CredentialKind,
  type CredentialSummary,
  nameSchema,
} from "@open-factory/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Plus, TriangleAlert } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ErrorLine } from "@/components/error-line";
import { FieldShell } from "@/components/field-shell";
import { FormField } from "@/components/form-field";
import { InlineOutcome } from "@/components/inline-outcome";
import { PasswordInput } from "@/components/password-input";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import {
  createCredential,
  credentialsQueryOptions,
  deleteCredential,
  replaceCredential,
  verifyCredential,
} from "@/features/settings/api";
import {
  AgentLinks,
  CodeText,
  focusOutcome,
  InlineForm,
  KIND_LABEL,
  MoreButton,
  RowLine,
  RowName,
  restartNote,
  SettingsList,
  SettingsSection,
  smallClass,
  TimeAgo,
  Usage,
  useFocusLater,
} from "@/features/settings/shared";
import { RATE_LIMIT_REFETCH_MS, RateLimitLine } from "./rate-limit-line";

type Outcome = { tone: "success" | "error" | "pending"; content: ReactNode; focusKey?: number };

const valueNoun = (k: CredentialKind) => (k === "oauth_token" ? "token" : "key");
const cap = (s: string) => s[0]?.toUpperCase() + s.slice(1);

/** Why Delete is disabled, shown inside the menu item; undefined when it can be deleted. */
function deleteBlocker(c: CredentialSummary): string | undefined {
  if (c.usedBy.length) return `used by ${c.usedBy.map((s) => `@${s}`).join(", ")}`;
  if (c.archivedUsedBy.length) {
    const many = c.archivedUsedBy.length > 1;
    return `archived ${c.archivedUsedBy.map((s) => `@${s}`).join(", ")} still ${many ? "use" : "uses"} it`;
  }
  return undefined;
}

/** The 409 credential_in_use race, with each agent linking to its edit page (where it's fixed). */
function InUseMessage({ usedBy, archived }: { usedBy: string[]; archived: string[] }) {
  return (
    <>
      {usedBy.length > 0 && (
        <>
          Used by <AgentLinks slugs={usedBy} edit />. Change their credential first.
        </>
      )}
      {usedBy.length > 0 && archived.length > 0 && " "}
      {archived.length > 0 && (
        <>
          Archived agents <AgentLinks slugs={archived} edit /> still reference it. Edit them first.
        </>
      )}
    </>
  );
}

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

type Verdict = { error?: string; warning?: string };
/** 422s from a verification turn: a rejection is the token's fault, the rest is transient. */
function verdictOf(err: unknown): Verdict | undefined {
  if (!(err instanceof ApiError)) return undefined;
  if (err.code === "credential_rejected") return { error: err.message };
  if (err.code === "credential_unverifiable") return { warning: err.message };
  return undefined;
}

function TokenField({
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

function AddCredentialForm({
  existing,
  onDone,
  onCancel,
}: {
  existing: string[];
  onDone(c: CredentialSummary): void;
  onCancel(): void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<CredentialKind>("oauth_token");
  const [value, setValue] = useState("");
  const [nameError, setNameError] = useState<string>();
  const [verdict, setVerdict] = useState<Verdict>({});
  const [formError, setFormError] = useState<string>();
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
    setFormError(undefined);
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
        else setFormError(err.message);
      } else {
        setFormError(
          err instanceof ApiError ? err.message : "Couldn't add the credential. Try again.",
        );
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <InlineForm
      label="Add credential"
      onSubmit={() => void submit()}
      onCancel={onCancel}
      submitLabel="Verify and add"
      pendingLabel="Verifying…"
      pending={pending}
      formError={formError}
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
      />
    </InlineForm>
  );
}

function ReplaceForm({
  credential,
  onDone,
  onCancel,
}: {
  credential: CredentialSummary;
  onDone(c: CredentialSummary): void;
  onCancel(): void;
}) {
  const [value, setValue] = useState("");
  const [verdict, setVerdict] = useState<Verdict>({});
  const [formError, setFormError] = useState<string>();
  const [pending, setPending] = useState(false);
  const noun = valueNoun(credential.kind);
  const fieldName = `credential-replace-${credential.name}`;

  async function submit() {
    setFormError(undefined);
    if (value.trim() === "") {
      setVerdict({ error: `Enter the new ${noun}.` });
      return document.getElementById(`field-${fieldName}`)?.focus();
    }
    setPending(true);
    try {
      onDone(await replaceCredential(credential.name, value));
    } catch (err) {
      const v = verdictOf(err);
      if (v) {
        setVerdict(v);
        if (v.error) document.getElementById(`field-${fieldName}`)?.focus();
      } else {
        setFormError(
          err instanceof ApiError ? err.message : `Couldn't replace the ${noun}. Try again.`,
        );
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <InlineForm
      label={`Replace ${noun} for ${credential.name}`}
      onSubmit={() => void submit()}
      onCancel={onCancel}
      submitLabel="Verify and save"
      pendingLabel="Verifying…"
      pending={pending}
      formError={formError}
    >
      <TokenField
        name={fieldName}
        label={`New ${noun}`}
        value={value}
        onChange={(v) => {
          setValue(v);
          setVerdict({});
        }}
        verdict={verdict}
      />
    </InlineForm>
  );
}

function VerificationState({ c }: { c: CredentialSummary }) {
  if (c.lastError) {
    return (
      <span className={`flex items-start gap-1.5 ${smallClass} text-destructive`}>
        <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
        <span>
          Last check failed: <CodeText text={c.lastError} />
        </span>
      </span>
    );
  }
  return (
    <span className={`${smallClass} text-muted-foreground`}>
      {c.lastVerifiedAt ? (
        <>
          Verified <TimeAgo iso={c.lastVerifiedAt} />
        </>
      ) : (
        "Not verified yet"
      )}
    </span>
  );
}

export function CredentialsSection() {
  const qc = useQueryClient();
  const query = useQuery({
    ...credentialsQueryOptions,
    refetchOnMount: false, // the settings loader just fetched it
    refetchInterval: RATE_LIMIT_REFETCH_MS,
  });
  const { data } = query;
  const focusLater = useFocusLater();
  const [adding, setAdding] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>();
  const [rowOutcome, setRowOutcome] = useState<Record<string, Outcome>>({});
  const [verifying, setVerifying] = useState<ReadonlySet<string>>(new Set());
  const [replacing, setReplacing] = useState<string>();
  // The dialog keeps its credential while it animates out; `confirmOpen` drives it.
  const [confirming, setConfirming] = useState<CredentialSummary>();
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Set when a menu item opens a form or dialog: the menu then hands focus to that field (or
  // leaves it to the dialog) instead of pulling it back to ⋯.
  const menuHandsOff = useRef<string | false>(false);
  // What the closing dialog should focus: the section line after a delete, the row line after a race.
  const afterDialog = useRef<string | undefined>(undefined);

  const refresh = () => qc.invalidateQueries({ queryKey: credentialsQueryOptions.queryKey });
  const setRow = (name: string, o: Outcome | undefined) =>
    setRowOutcome((s) => {
      const next = { ...s };
      if (o) next[name] = o;
      else delete next[name];
      return next;
    });
  const upsert = (c: CredentialSummary) =>
    qc.setQueryData(credentialsQueryOptions.queryKey, (old) =>
      old?.some((x) => x.name === c.name)
        ? old.map((x) => (x.name === c.name ? c : x))
        : [...(old ?? []), c].sort((a, b) => a.name.localeCompare(b.name)),
    );

  async function verify(c: CredentialSummary) {
    if (verifying.has(c.name)) return;
    setVerifying((v) => new Set(v).add(c.name));
    setRow(c.name, undefined);
    try {
      const r = await verifyCredential(c.name);
      upsert(r);
      setRow(
        c.name,
        r.lastError
          ? { tone: "error", content: <CodeText text={`Check failed: ${r.lastError}`} /> }
          : { tone: "success", content: "Verified." },
      );
    } catch (err) {
      setRow(c.name, {
        tone: "error",
        content: err instanceof ApiError ? err.message : "Couldn't verify. Try again.",
      });
    } finally {
      setVerifying((v) => {
        const next = new Set(v);
        next.delete(c.name);
        return next;
      });
    }
  }

  async function remove(c: CredentialSummary) {
    try {
      await deleteCredential(c.name);
      qc.setQueryData(credentialsQueryOptions.queryKey, (old) =>
        old?.filter((x) => x.name !== c.name),
      );
      setOutcome({ tone: "success", content: `Deleted ${c.name}.` });
      afterDialog.current = "credentials-outcome";
      void refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === "credential_in_use") {
        const list = (k: string) =>
          Array.isArray(err.body[k]) ? (err.body[k] as unknown[]).map(String) : [];
        setRow(c.name, {
          tone: "error",
          content: <InUseMessage usedBy={list("usedBy")} archived={list("archivedUsedBy")} />,
        });
        afterDialog.current = `credential-outcome-${c.name}`;
        void refresh();
        return;
      }
      throw err;
    }
  }

  const credentials = data ?? [];
  return (
    <SettingsSection
      id="credentials"
      title="Credentials"
      description="Claude logins agents use. Each agent picks one."
    >
      {!data && query.isError && (
        <ErrorLine text="Couldn't load credentials." onRetry={() => void query.refetch()} />
      )}
      {data &&
        (credentials.length === 0 ? (
          <p className="text-sm text-muted-foreground">No credentials yet.</p>
        ) : (
          <SettingsList>
            {credentials.map((c) => {
              const blocker = deleteBlocker(c);
              const noun = valueNoun(c.kind);
              const busy = verifying.has(c.name);
              return (
                <li
                  key={c.name}
                  data-name={c.name}
                  className="grid grid-cols-[minmax(0,1fr)] gap-1 px-2 py-1.5"
                >
                  <RowLine
                    actions={
                      <>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          aria-disabled={busy || undefined}
                          onClick={() => void verify(c)}
                        >
                          {busy && <Spinner />}
                          {busy ? "Verifying…" : "Verify"}
                        </Button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <MoreButton
                              id={`credential-menu-${c.name}`}
                              label={`Actions for ${c.name}`}
                            />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent
                            align="end"
                            onCloseAutoFocus={(e) => {
                              const target = menuHandsOff.current;
                              menuHandsOff.current = false;
                              if (target === false) return;
                              e.preventDefault();
                              if (target) document.getElementById(target)?.focus();
                            }}
                          >
                            <DropdownMenuItem
                              onSelect={() => {
                                menuHandsOff.current = `field-credential-replace-${c.name}`;
                                setRow(c.name, undefined);
                                setReplacing(c.name);
                              }}
                            >
                              {`Replace ${noun}`}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              disabled={Boolean(blocker)}
                              onSelect={() => {
                                menuHandsOff.current = ""; // the dialog places focus
                                afterDialog.current = undefined;
                                setConfirming(c);
                                setConfirmOpen(true);
                              }}
                            >
                              {blocker ? `Delete (${blocker})` : "Delete…"}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </>
                    }
                  >
                    <RowName>{c.name}</RowName>
                    <span className="text-[0.8125rem] md:w-24 md:shrink-0">
                      {KIND_LABEL[c.kind]}
                    </span>
                    <VerificationState c={c} />
                    <RateLimitLine
                      rateLimit={c.rateLimit}
                      pausedUntil={c.pausedUntil}
                      pauseExact={c.pauseExact}
                    />
                    <Usage
                      active={c.usedBy}
                      archived={c.archivedUsedBy}
                      verb="Used by"
                      none="Not used"
                    />
                  </RowLine>
                  <span role="status" className="sr-only">
                    {busy ? `Verifying ${c.name}…` : ""}
                  </span>
                  <div id={`credential-outcome-${c.name}`}>
                    <InlineOutcome
                      tone={rowOutcome[c.name]?.tone}
                      focusKey={rowOutcome[c.name]?.focusKey}
                    >
                      {rowOutcome[c.name]?.content}
                    </InlineOutcome>
                  </div>
                  {replacing === c.name && (
                    <ReplaceForm
                      credential={c}
                      onCancel={() => {
                        setReplacing(undefined);
                        focusLater(`credential-menu-${c.name}`);
                      }}
                      onDone={(r) => {
                        upsert(r);
                        setReplacing(undefined);
                        setRow(c.name, {
                          tone: "success",
                          content: `Saved. ${restartNote(r.usedBy)}`.trim(),
                          focusKey: Date.now(),
                        });
                        void refresh();
                      }}
                    />
                  )}
                </li>
              );
            })}
          </SettingsList>
        ))}
      {/* Empty, it takes no space; it stays mounted so its text is announced. */}
      <div id="credentials-outcome" className="[&:not(:has([tabindex]))]:-mt-3">
        <InlineOutcome tone={outcome?.tone} focusKey={outcome?.focusKey}>
          {outcome?.content}
        </InlineOutcome>
      </div>
      {adding ? (
        <AddCredentialForm
          existing={credentials.map((c) => c.name)}
          onCancel={() => {
            setAdding(false);
            focusLater("credentials-add");
          }}
          onDone={(c) => {
            upsert(c);
            setAdding(false);
            setOutcome({ tone: "success", content: `Added ${c.name}.`, focusKey: Date.now() });
            void refresh();
          }}
        />
      ) : (
        <div>
          <Button
            id="credentials-add"
            type="button"
            variant="ghost"
            onClick={() => {
              setOutcome(undefined);
              setAdding(true);
            }}
          >
            <Plus aria-hidden="true" data-icon="inline-start" />
            Add credential
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Delete credential ${confirming?.name ?? ""}?`}
        body={
          confirming?.kind === "api_key" ? (
            "Its API key is erased and can't be shown again."
          ) : (
            <>
              Its token is erased and can't be shown again. To use it later, create a new one with{" "}
              <code className="font-mono text-[0.8125rem]">claude setup-token</code>.
            </>
          )
        }
        confirmLabel={`Delete ${confirming?.name ?? ""}`}
        pendingLabel="Deleting…"
        onConfirm={() => (confirming ? remove(confirming) : undefined)}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          const target = afterDialog.current;
          const name = confirming?.name;
          if (target) focusOutcome(target);
          else if (name) document.getElementById(`credential-menu-${name}`)?.focus();
        }}
      />
    </SettingsSection>
  );
}
