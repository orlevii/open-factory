import { ApiError, type CredentialSummary } from "@open-factory/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CircleAlert, Plus } from "lucide-react";
import {
  memo,
  type ReactNode,
  type RefObject,
  type TransitionEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CodeText } from "@/components/code-text";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ErrorLine } from "@/components/error-line";
import { useOutcome } from "@/components/forms/form-outcome";
import { useFieldErrors } from "@/components/forms/use-field-errors";
import { InlineOutcome } from "@/components/inline-outcome";
import {
  AdaptiveMenuContent,
  AdaptiveMenuItem,
  AdaptiveMenuSeparator,
  AdaptiveMenuTrigger,
} from "@/components/ui/adaptive-menu";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  credentialsQueryOptions,
  deleteCredential,
  replaceCredential,
  verifyCredential,
} from "@/features/settings/api";
import {
  AgentLinks,
  cappedList,
  focusOutcome,
  InlineForm,
  KIND_LABEL,
  MoreButton,
  RowLine,
  RowName,
  restartNote,
  SettingsList,
  SettingsRow,
  SettingsRowMenu,
  SettingsSection,
  smallClass,
  TimeAgo,
  Usage,
  useFocusLater,
} from "@/features/settings/shared";
import { sheetIntent } from "@/features/sheets/sheet-bodies";
import { openSheet } from "@/features/sheets/sheet-store";
import { type Arrival, arrive, useArrivalTint } from "@/lib/use-arrival";
import { AddCredentialForm } from "./forms/add-credential-form";
import {
  enterValueMessage,
  replaceFailedMessage,
  TokenField,
  valueNoun,
  verdictOf,
} from "./forms/shared";
import { RATE_LIMIT_REFETCH_MS, RateLimitLine } from "./rate-limit-line";
import { type ExpiryState, expiryState } from "./sign-in/expiry";

const FIELDS = ["value"] as const;

type Outcome = { tone: "success" | "error" | "pending"; content: ReactNode; focusKey?: number };

const handles = (slugs: string[]) => cappedList(slugs.map((s) => `@${s}`));

/** Why Delete is disabled, shown inside the menu item; undefined when it can be deleted. At most three
 *  agents are named (the row's Usage line lists them all). */
function deleteBlocker(c: CredentialSummary): string | undefined {
  if (c.usedBy.length) return `used by ${handles(c.usedBy)}`;
  if (c.archivedUsedBy.length) {
    const many = c.archivedUsedBy.length > 1;
    return `archived ${handles(c.archivedUsedBy)} still ${many ? "use" : "uses"} it`;
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
  // A transient verification problem: described under the token but not invalid.
  const [warning, setWarning] = useState<string>();
  const o = useOutcome();
  const [pending, setPending] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const noun = valueNoun(credential.kind);

  const f = useFieldErrors({
    form: formRef,
    fields: FIELDS,
    checks: { value: () => (value.trim() === "" ? enterValueMessage(credential.kind) : undefined) },
  });

  async function submit() {
    o.clear();
    setWarning(undefined);
    if (!f.submit()) return;
    setPending(true);
    try {
      onDone(await replaceCredential(credential.name, value));
    } catch (err) {
      setPending(false);
      const v = verdictOf(err);
      if (v?.error) f.set("value", v.error, { focus: true });
      else if (v?.warning) {
        // The note isn't a live region: the outcome line is what announces the warning (spec §6.4).
        setWarning(v.warning);
        o.fail(replaceFailedMessage(credential.kind));
      } else o.fail(err instanceof ApiError ? err.message : replaceFailedMessage(credential.kind));
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
      outcome={o.outcome}
      ref={formRef}
    >
      <TokenField
        name={`credential-replace-${credential.name}`}
        label={`New ${noun}`}
        value={value}
        onChange={(v) => {
          setValue(v);
          setWarning(undefined);
          f.change("value");
        }}
        onBlur={(e) => f.blur("value", e)}
        verdict={{ error: f.errors.value, warning }}
        kind={credential.kind}
      />
    </InlineForm>
  );
}

/** `muted`: the credential expired, so its crimson expiry line already says it: a failed check then shows
 *  nothing, a verified or unverified state its muted form (no second crimson line, spec §8.4). */
function VerificationState({ c, muted }: { c: CredentialSummary; muted: boolean }) {
  if (c.lastError) {
    if (muted) return null;
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

const EXPIRY_TONE = {
  muted: "text-muted-foreground",
  warning: "text-warning",
  crimson: "text-destructive",
} as const;

function ExpiryLine({ ex }: { ex: Exclude<ExpiryState, { tone: "none" }> }) {
  return (
    <span className={`flex items-start gap-1.5 ${smallClass} ${EXPIRY_TONE[ex.tone]}`}>
      {ex.tone !== "muted" && (
        <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      )}
      <span>{ex.text}</span>
    </span>
  );
}

type CredentialRowProps = {
  c: CredentialSummary;
  /** Minute-rounded, from the section, so a row's memo holds between minutes. */
  now: number;
  busy: boolean;
  outcome: Outcome | undefined;
  replacing: boolean;
  /** The tint, only for the arrived row. */
  arrival: Arrival | undefined;
  onArrivedEnd(): void;
  onVerify(c: CredentialSummary): void;
  onReplace(name: string): void;
  onReplaceDone(r: CredentialSummary): void;
  onReplaceCancel(name: string): void;
  onDelete(c: CredentialSummary): void;
  menuHandsOff: RefObject<string | false>;
};

const CredentialRow = memo(function CredentialRow(p: CredentialRowProps) {
  const { c } = p;
  const blocker = deleteBlocker(c);
  const noun = valueNoun(c.kind);
  const oauth = c.kind === "oauth_token";
  const ex = expiryState(c.expiresAt, new Date(p.now));
  const expired = ex.tone === "crimson";
  // A rejected (not expired) OAuth credential gets the button after its failure line, an expired or
  // expiring one after its expiry line.
  const needsSignIn = oauth && (("needsSignIn" in ex && ex.needsSignIn) || c.rejected);
  const intent = useMemo(
    () => sheetIntent("sign-in-again", { kind: "sign-in-again", name: c.name }),
    [c.name],
  );
  const signInAgain = () => openSheet({ kind: "sign-in-again", name: c.name });
  const signInButton = (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      data-sign-in-again=""
      {...intent}
      onClick={signInAgain}
    >
      Sign in again
    </Button>
  );
  // A rejected credential whose expiry says nothing loud: the button follows its failure line directly.
  const buttonAfterFailure = c.rejected && (ex.tone === "none" || ex.tone === "muted");
  const rowProps = p.arrival
    ? {
        "data-arrived": p.arrival === "fading" ? "fading" : "",
        onTransitionEnd: (e: TransitionEvent) => {
          if (e.target !== e.currentTarget || p.arrival !== "fading") return;
          if (e.propertyName && e.propertyName !== "opacity") return;
          p.onArrivedEnd();
        },
      }
    : {};
  return (
    <SettingsRow
      data-name={c.name}
      data-credential-row=""
      tabIndex={-1}
      {...rowProps}
      className="grid grid-cols-[minmax(0,1fr)] gap-1 px-2 py-1.5"
    >
      <RowLine
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-disabled={p.busy || undefined}
              onClick={() => p.onVerify(c)}
            >
              {p.busy && <Spinner />}
              {p.busy ? "Verifying…" : "Verify"}
            </Button>
            <SettingsRowMenu title={c.name}>
              <AdaptiveMenuTrigger asChild>
                <MoreButton id={`credential-menu-${c.name}`} label={`Actions for ${c.name}`} />
              </AdaptiveMenuTrigger>
              <AdaptiveMenuContent
                align="end"
                onCloseAutoFocus={(e) => {
                  const target = p.menuHandsOff.current;
                  p.menuHandsOff.current = false;
                  if (target === false) return;
                  e.preventDefault();
                  if (target) document.getElementById(target)?.focus();
                }}
              >
                {oauth && (
                  <AdaptiveMenuItem
                    opensOverlay
                    {...intent}
                    onSelect={() => {
                      p.menuHandsOff.current = ""; // the sheet places focus
                      signInAgain();
                    }}
                  >
                    Sign in again
                  </AdaptiveMenuItem>
                )}
                <AdaptiveMenuItem
                  onSelect={() => {
                    p.menuHandsOff.current = `field-credential-replace-${c.name}`;
                    p.onReplace(c.name);
                  }}
                >
                  {`Replace ${noun}`}
                </AdaptiveMenuItem>
                <AdaptiveMenuSeparator />
                <AdaptiveMenuItem
                  variant="destructive"
                  opensOverlay
                  disabled={Boolean(blocker)}
                  onSelect={() => {
                    p.menuHandsOff.current = ""; // the dialog places focus
                    p.onDelete(c);
                  }}
                >
                  {blocker ? `Delete (${blocker})` : "Delete…"}
                </AdaptiveMenuItem>
              </AdaptiveMenuContent>
            </SettingsRowMenu>
          </>
        }
      >
        <RowName>{c.name}</RowName>
        <span className="text-[0.8125rem] md:w-24 md:shrink-0">{KIND_LABEL[c.kind]}</span>
        <VerificationState c={c} muted={expired} />
        {needsSignIn && buttonAfterFailure && signInButton}
        {ex.tone !== "none" && <ExpiryLine ex={ex} />}
        {needsSignIn && !buttonAfterFailure && signInButton}
        <RateLimitLine
          rateLimit={c.rateLimit}
          pausedUntil={c.pausedUntil}
          pauseExact={c.pauseExact}
        />
        <Usage active={c.usedBy} archived={c.archivedUsedBy} verb="Used by" none="Not used" />
      </RowLine>
      <span role="status" className="sr-only">
        {p.busy ? `Verifying ${c.name}…` : ""}
      </span>
      <div id={`credential-outcome-${c.name}`}>
        <InlineOutcome tone={p.outcome?.tone} focusKey={p.outcome?.focusKey}>
          {p.outcome?.content}
        </InlineOutcome>
      </div>
      {p.replacing && (
        <ReplaceForm
          credential={c}
          onCancel={() => p.onReplaceCancel(c.name)}
          onDone={p.onReplaceDone}
        />
      )}
    </SettingsRow>
  );
});

export function CredentialsSection(p: { arriveAt?: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
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
  const verifyingRef = useRef<ReadonlySet<string>>(verifying);
  const [replacing, setReplacing] = useState<string>();
  // The dialog keeps its credential while it animates out; `confirmOpen` drives it.
  const [confirming, setConfirming] = useState<CredentialSummary>();
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Set when a menu item opens a form or dialog: the menu then hands focus to that field (or
  // leaves it to the dialog) instead of pulling it back to ⋯.
  const menuHandsOff = useRef<string | false>(false);
  // What the closing dialog should focus: the section line after a delete, the row line after a race.
  const afterDialog = useRef<string | undefined>(undefined);
  const { arrival, start, onArrivedEnd } = useArrivalTint();
  const [arrivedName, setArrivedName] = useState<string>();
  // Minute-rounded, so memoised rows re-render once a minute at most (the inbox list's pattern).
  const now = Math.floor(Date.now() / 60_000) * 60_000;

  // Arrive once per `?credential=` value, after the list loaded; the param is cleared either way.
  const target = p.arriveAt;
  const loaded = query.isSuccess || query.isError;
  useEffect(() => {
    if (!target || !loaded) return;
    const row = document.querySelector<HTMLElement>(`[data-name="${CSS.escape(target)}"]`);
    if (row) {
      row.scrollIntoView({ block: "center" }); // arrive() focuses without scrolling
      const button = row.querySelector<HTMLElement>("[data-sign-in-again]");
      arrive(button ?? row);
      setArrivedName(target);
      start();
    }
    void navigate({ to: "/settings/credentials", search: {}, replace: true });
  }, [target, loaded, navigate, start]);

  const refresh = useCallback(
    () => qc.invalidateQueries({ queryKey: credentialsQueryOptions.queryKey }),
    [qc],
  );
  const setRow = useCallback(
    (name: string, o: Outcome | undefined) =>
      setRowOutcome((s) => {
        const next = { ...s };
        if (o) next[name] = o;
        else delete next[name];
        return next;
      }),
    [],
  );
  const upsert = useCallback(
    (c: CredentialSummary) =>
      qc.setQueryData(credentialsQueryOptions.queryKey, (old) =>
        old?.some((x) => x.name === c.name)
          ? old.map((x) => (x.name === c.name ? c : x))
          : [...(old ?? []), c].sort((a, b) => a.name.localeCompare(b.name)),
      ),
    [qc],
  );
  const setVerifyingNow = useCallback((f: (v: ReadonlySet<string>) => ReadonlySet<string>) => {
    verifyingRef.current = f(verifyingRef.current);
    setVerifying(verifyingRef.current);
  }, []);

  const onVerify = useCallback(
    async (c: CredentialSummary) => {
      if (verifyingRef.current.has(c.name)) return;
      setVerifyingNow((v) => new Set(v).add(c.name));
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
        setVerifyingNow((v) => {
          const next = new Set(v);
          next.delete(c.name);
          return next;
        });
      }
    },
    [setRow, setVerifyingNow, upsert],
  );
  const onReplace = useCallback(
    (name: string) => {
      setRow(name, undefined);
      setReplacing(name);
    },
    [setRow],
  );
  const onReplaceDone = useCallback(
    (r: CredentialSummary) => {
      upsert(r);
      setReplacing(undefined);
      setRow(r.name, {
        tone: "success",
        content: `Saved. ${restartNote(r.usedBy)}`.trim(),
        focusKey: Date.now(),
      });
      void refresh();
    },
    [refresh, setRow, upsert],
  );
  const onReplaceCancel = useCallback(
    (name: string) => {
      setReplacing(undefined);
      focusLater(`credential-menu-${name}`);
    },
    [focusLater],
  );
  const onDelete = useCallback((c: CredentialSummary) => {
    afterDialog.current = undefined;
    setConfirming(c);
    setConfirmOpen(true);
  }, []);

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
            {credentials.map((c) => (
              <CredentialRow
                key={c.name}
                c={c}
                now={now}
                busy={verifying.has(c.name)}
                outcome={rowOutcome[c.name]}
                replacing={replacing === c.name}
                arrival={c.name === arrivedName ? arrival : undefined}
                onArrivedEnd={onArrivedEnd}
                onVerify={onVerify}
                onReplace={onReplace}
                onReplaceDone={onReplaceDone}
                onReplaceCancel={onReplaceCancel}
                onDelete={onDelete}
                menuHandsOff={menuHandsOff}
              />
            ))}
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
          frame="inline"
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
              Its token is erased and can't be shown again. To use it later, add it again with Sign
              in with Claude.
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
