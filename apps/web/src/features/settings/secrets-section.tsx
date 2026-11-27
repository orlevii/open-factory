import { ApiError, type SecretSummary } from "@open-factory/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, Plus } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ErrorLine } from "@/components/error-line";
import { useOutcome } from "@/components/forms/form-outcome";
import { useFieldErrors } from "@/components/forms/use-field-errors";
import { InlineOutcome } from "@/components/inline-outcome";
import { Button } from "@/components/ui/button";
import { deleteSecret, putSecret, secretsQueryOptions } from "@/features/settings/api";
import {
  focusOutcome,
  InlineForm,
  mentions,
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
import { FORM_MSG } from "@/lib/form-messages.ts";
import { AddSecretForm } from "./forms/add-secret-form";
import { ValueField } from "./forms/shared";

const FIELDS = ["value"] as const;

type Outcome = { tone: "success" | "error" | "pending"; content: ReactNode; focusKey?: number };

const withNote = (head: string, users: string[]) => `${head} ${restartNote(users)}`.trim();

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
  const o = useOutcome();
  const [pending, setPending] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const f = useFieldErrors({
    form: formRef,
    fields: FIELDS,
    checks: { value: () => (value === "" ? FORM_MSG.enterValue : undefined) },
  });

  async function submit() {
    o.clear();
    if (!f.submit()) return;
    setPending(true);
    try {
      onDone(await putSecret(secret.name, value));
    } catch (err) {
      setPending(false);
      o.fail(err instanceof ApiError ? err.message : "Couldn't save the value. Try again.");
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
      outcome={o.outcome}
      ref={formRef}
    >
      <ValueField
        name={`secret-update-${secret.name}`}
        label="New value"
        value={value}
        error={f.errors.value}
        onChange={(v) => {
          setValue(v);
          f.change("value");
        }}
        onBlur={(e) => f.blur("value", e)}
      />
    </InlineForm>
  );
}

function deleteBody(users: string[]) {
  if (users.length === 0) return "Its value is erased. No agent uses it.";
  const verb = users.length === 1 ? "restarts" : "restart";
  return `Its value is erased. ${mentions(users)} ${verb} when idle without it and won't start until you add it again.`;
}

export function SecretsSection({ addSecret }: { addSecret?: string }) {
  const qc = useQueryClient();
  const query = useQuery({ ...secretsQueryOptions, refetchOnMount: false }); // the settings loader just fetched it;
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

  // A later link to ?addSecret=NAME (while already here) opens the form with that name. Adjusted
  // during render, so the form opens in the same pass rather than after an effect.
  const [seen, setSeen] = useState(addSecret);
  if (addSecret && addSecret !== seen) {
    setSeen(addSecret);
    setPrefill(addSecret.toUpperCase());
    setAdding(true);
  }

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
          frame="inline"
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
        pendingLabel="Deleting…"
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
