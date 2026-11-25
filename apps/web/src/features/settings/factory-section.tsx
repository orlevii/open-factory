import {
  ApiError,
  type FactorySettingsDto,
  type PatchFactorySettings,
  patchFactorySettingsSchema,
} from "@open-factory/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { CodeText } from "@/components/code-text";
import { ErrorLine } from "@/components/error-line";
import { FieldShell } from "@/components/field-shell";
import { FormOutcome, useOutcome } from "@/components/forms/form-outcome";
import { useFieldErrors } from "@/components/forms/use-field-errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { FORM_MSG } from "@/lib/form-messages.ts";
import { factorySettingsQueryOptions, patchFactorySettings } from "./api";
import { SettingsSection, smallClass } from "./shared";

const FIELDS = ["warmWindowMinutes", "memberUpdateDebounceSeconds"] as const;
type Field = (typeof FIELDS)[number];
type Values = Record<Field, string>;

const valuesOf = (s: FactorySettingsDto): Values => ({
  warmWindowMinutes: String(s.warmWindowMinutes),
  memberUpdateDebounceSeconds: String(s.memberUpdateDebounceSeconds),
});
const same = (a: Values, b: Values) => FIELDS.every((f) => a[f] === b[f]);
const toNumber = (s: string) => (s.trim() === "" ? Number.NaN : Number(s));

/** The shared PATCH schema's sentence for the field ("Enter a whole number from 1 to 1440."). */
function check(f: Field, raw: string): string | undefined {
  const r = patchFactorySettingsSchema.shape[f].safeParse(toNumber(raw));
  return r.success ? undefined : r.error.issues[0]?.message;
}

const HINTS: Record<Field, string> = {
  warmWindowMinutes:
    "How long an idle agent stays running before it hibernates (1–1440 min). Templates can set their own with warm_window_minutes.",
  memberUpdateDebounceSeconds:
    "How long to collect status changes from an agent's reports before telling it (0–86400 seconds). 0 delivers each update at once.",
};
const LABELS: Record<Field, string> = {
  warmWindowMinutes: "Default warm window",
  memberUpdateDebounceSeconds: "Member-update debounce",
};

/** Settings → Factory (spec §12.4): one form, validated on blur and on Save. */
export function FactorySection() {
  const query = useQuery(factorySettingsQueryOptions);
  return (
    <SettingsSection id="factory" title="Factory">
      {!query.data && query.isError && (
        <ErrorLine text="Couldn't load factory settings." onRetry={() => void query.refetch()} />
      )}
      {query.data && <FactoryForm server={query.data} />}
    </SettingsSection>
  );
}

function FactoryForm({ server }: { server: FactorySettingsDto }) {
  const qc = useQueryClient();
  const [v, setV] = useState<Values>(() => valuesOf(server));
  // The values the form was loaded with (or last saved): edits and conflicts compare against them.
  const base = useRef<Values>(valuesOf(server));
  const [pending, setPending] = useState(false);
  const o = useOutcome();
  const [conflict, setConflict] = useState(false);
  const form = useRef<HTMLFormElement>(null);

  const changed = (f: Field) => v[f] !== base.current[f];
  const dirty = FIELDS.some(changed);

  const f = useFieldErrors({
    form,
    fields: FIELDS,
    checks: {
      warmWindowMinutes: () => check("warmWindowMinutes", v.warmWindowMinutes),
      memberUpdateDebounceSeconds: () =>
        check("memberUpdateDebounceSeconds", v.memberUpdateDebounceSeconds),
    },
  });

  // A `settings_changed` frame refetches the settings (the app shell invalidates them). Clean, the
  // form takes the new values; dirty, it keeps the edits and says so. Our own save's echo equals
  // `base`, so it is no conflict. No concurrency token exists: last write wins.
  const serverValues = valuesOf(server);
  const serverKey = JSON.stringify(serverValues);
  // While our own save is in flight its echo may land first (the server publishes before it
  // answers): the save's answer sets `base`, and this runs again once it has.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a change on the server (or a clean form) counts
  useEffect(() => {
    if (pending) return;
    // Back to what we loaded (someone reverted their change): nothing to warn about any more.
    if (same(serverValues, base.current)) {
      setConflict(false);
      return;
    }
    if (dirty) {
      setConflict(true);
      return;
    }
    base.current = serverValues;
    setV(serverValues);
    setConflict(false);
  }, [serverKey, dirty, pending]);

  function reload() {
    base.current = serverValues;
    setV(serverValues);
    f.reset();
    o.clear();
    setConflict(false);
  }

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    if (pending) return;
    o.clear();
    const changedFields = FIELDS.filter(changed);
    if (!f.submit(changedFields) || !dirty) return;
    const body: PatchFactorySettings = {};
    for (const k of changedFields) body[k] = toNumber(v[k]);
    setPending(true);
    try {
      const saved = await patchFactorySettings(body);
      const next = valuesOf(saved);
      // `base` first: the cache update below must not read as someone else's change.
      base.current = next;
      setV(next);
      setConflict(false);
      qc.setQueryData(factorySettingsQueryOptions.queryKey, saved);
      setPending(false);
      o.succeed("Saved.");
    } catch (err) {
      setPending(false);
      const fields =
        err instanceof ApiError ? (err.body.fields as Record<string, string>) : undefined;
      if (!f.server(fields)) o.fail(FORM_MSG.saveFailed);
    }
  }

  const numberField = (k: Field, suffix: string) => (
    <FieldShell name={k} label={LABELS[k]} error={f.errors[k]} help={HINTS[k]}>
      {(a) => (
        <div className="flex items-center gap-2">
          <Input
            id={a.id}
            name={k}
            type="number"
            inputMode="numeric"
            aria-invalid={a.invalid || undefined}
            aria-describedby={a.describedBy}
            className="h-9 w-28 tabular-nums"
            value={v[k]}
            onChange={(e) => {
              const value = e.target.value;
              setV((x) => ({ ...x, [k]: value }));
              f.change(k);
              o.clear();
            }}
            onBlur={(e) => f.blur(k, e)}
          />
          <span aria-hidden="true" className={`${smallClass} text-muted-foreground`}>
            {suffix}
          </span>
        </div>
      )}
    </FieldShell>
  );

  return (
    <form ref={form} noValidate onSubmit={submit} className="field-stack max-w-xl">
      {conflict && dirty && (
        <div role="status" className={`${smallClass} flex items-center gap-2`}>
          <span>These settings were changed elsewhere.</span>
          <Button type="button" variant="ghost" size="sm" onClick={reload}>
            Reload
          </Button>
        </div>
      )}
      <fieldset disabled={pending} className="field-stack">
        {numberField("warmWindowMinutes", "min")}
        {numberField("memberUpdateDebounceSeconds", "seconds")}
        <div className="grid gap-0.5">
          <p className="text-[0.8125rem] font-medium">
            {`Local runtime: ${server.allowLocalRuntime ? "Allowed" : "Not allowed"}`}
          </p>
          <p className={`${smallClass} text-muted-foreground`}>
            <CodeText text="Set `FACTORY_ALLOW_LOCAL_RUNTIME` on the server and restart to change it." />
          </p>
        </div>
        <FormOutcome outcome={o.outcome} pending={pending ? "Saving…" : undefined} />
        <div>
          <Button type="submit" aria-disabled={pending || undefined}>
            {pending && <Spinner />}
            Save
          </Button>
        </div>
      </fieldset>
    </form>
  );
}
