import {
  ApiError,
  type FactorySettingsDto,
  type PatchFactorySettings,
  patchFactorySettingsSchema,
} from "@open-factory/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ErrorLine } from "@/components/error-line";
import { FieldShell } from "@/components/field-shell";
import { InlineOutcome } from "@/components/inline-outcome";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { runningQueryOptions } from "@/features/session/api";
import { useAgentStatusFrames } from "@/features/session/use-agent-status";
import { factorySettingsQueryOptions, patchFactorySettings } from "./api";
import { CodeText, SettingsSection, smallClass } from "./shared";

const FIELDS = [
  "maxRunningAgents",
  "defaultWarmWindowMinutes",
  "memberUpdateDebounceSeconds",
] as const;
type Field = (typeof FIELDS)[number];
type Values = Record<Field, string>;
type Errors = Partial<Record<Field, string>>;

const valuesOf = (s: FactorySettingsDto): Values => ({
  maxRunningAgents: String(s.maxRunningAgents),
  defaultWarmWindowMinutes: String(s.defaultWarmWindowMinutes),
  memberUpdateDebounceSeconds: String(s.memberUpdateDebounceSeconds),
});
const same = (a: Values, b: Values) => FIELDS.every((f) => a[f] === b[f]);
const toNumber = (s: string) => (s.trim() === "" ? Number.NaN : Number(s));

/** The shared PATCH schema's sentence for the field ("Enter a whole number from 1 to 64."). */
function check(f: Field, raw: string): string | undefined {
  const r = patchFactorySettingsSchema.shape[f].safeParse(toNumber(raw));
  return r.success ? undefined : r.error.issues[0]?.message;
}

const HINTS: Record<Field, string> = {
  maxRunningAgents:
    "Agents that can run at once (1–64). Lowering it never interrupts a turn; idle agents may hibernate sooner.",
  // No server field says whether older agents hold a stored window, so the sentence is always there (spec §12.4).
  defaultWarmWindowMinutes:
    "How long an idle agent stays running before it hibernates (1–1440 min). Templates can set their own with warm_window_minutes. Agents created before this change keep 70 min until re-synced.",
  memberUpdateDebounceSeconds:
    "How long to collect status changes from an agent's reports before telling it (0–86400 s). 0 sends each change at once.",
};
const LABELS: Record<Field, string> = {
  maxRunningAgents: "Concurrency cap",
  defaultWarmWindowMinutes: "Default warm window",
  memberUpdateDebounceSeconds: "Member-update debounce",
};

/** "3 of 8 running": the list fetch seeds it, `supervisor` frames keep it live. */
function RunningCount() {
  useAgentStatusFrames();
  const { data } = useQuery(runningQueryOptions);
  if (!data) return null;
  return (
    <span className={`${smallClass} whitespace-nowrap text-muted-foreground tabular-nums`}>
      {data.count} of {data.max} running
    </span>
  );
}

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
  const [errors, setErrors] = useState<Errors>({});
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<"saved" | "failed" | undefined>();
  const [conflict, setConflict] = useState(false);
  const form = useRef<HTMLFormElement>(null);

  const changed = (f: Field) => v[f] !== base.current[f];
  const dirty = FIELDS.some(changed);

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

  const focus = (f: Field) => form.current?.querySelector<HTMLElement>(`#field-${f}`)?.focus();

  function reload() {
    base.current = serverValues;
    setV(serverValues);
    setErrors({});
    setOutcome(undefined);
    setConflict(false);
  }

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    if (pending) return;
    setOutcome(undefined);
    const found: Errors = {};
    for (const f of FIELDS) if (changed(f)) found[f] = check(f, v[f]);
    setErrors(found);
    const first = FIELDS.find((f) => found[f]);
    if (first) return focus(first);
    if (!dirty) return;
    const body: PatchFactorySettings = {};
    for (const f of FIELDS) if (changed(f)) body[f] = toNumber(v[f]);
    setPending(true);
    try {
      const saved = await patchFactorySettings(body);
      const next = valuesOf(saved);
      // `base` first: the cache update below must not read as someone else's change.
      base.current = next;
      setV(next);
      setConflict(false);
      qc.setQueryData(factorySettingsQueryOptions.queryKey, saved);
      setOutcome("saved");
    } catch (err) {
      if (err instanceof ApiError) {
        const fields = (err.body.fields ?? {}) as Record<string, string>;
        const e: Errors = {};
        for (const f of FIELDS) if (fields[f]) e[f] = fields[f];
        if (Object.keys(e).length > 0) {
          // Commit now: the fieldset must be enabled again before its field can take focus.
          flushSync(() => {
            setErrors(e);
            setPending(false);
          });
          focus(FIELDS.find((f) => e[f]) as Field);
          return;
        }
      }
      setOutcome("failed");
    } finally {
      setPending(false);
    }
  }

  const numberField = (f: Field, suffix?: string, after?: ReactNode) => (
    <FieldShell name={f} label={LABELS[f]} error={errors[f]} help={HINTS[f]}>
      {(a) => (
        <div className="flex items-center gap-2">
          <Input
            id={a.id}
            name={f}
            type="number"
            inputMode="numeric"
            aria-invalid={a.invalid || undefined}
            aria-describedby={a.describedBy}
            className="h-9 w-28 bg-card tabular-nums dark:bg-card"
            value={v[f]}
            onChange={(e) => {
              const value = e.target.value;
              setV((x) => ({ ...x, [f]: value }));
              setErrors((x) => ({ ...x, [f]: undefined }));
              setOutcome(undefined);
            }}
            onBlur={() => setErrors((x) => ({ ...x, [f]: check(f, v[f]) }))}
          />
          {suffix && (
            <span aria-hidden="true" className={`${smallClass} text-muted-foreground`}>
              {suffix}
            </span>
          )}
          {after}
        </div>
      )}
    </FieldShell>
  );

  return (
    <form ref={form} noValidate onSubmit={submit} className="grid max-w-xl gap-5">
      {conflict && dirty && (
        <div role="status" className={`${smallClass} flex items-center gap-2`}>
          <span>These settings were changed elsewhere.</span>
          <Button type="button" variant="outline" size="sm" onClick={reload}>
            Reload
          </Button>
        </div>
      )}
      <fieldset disabled={pending} className="grid min-w-0 gap-5">
        {numberField("maxRunningAgents", undefined, <RunningCount />)}
        {numberField("defaultWarmWindowMinutes", "min")}
        {numberField("memberUpdateDebounceSeconds", "s")}
        <div className="grid gap-0.5">
          <p className="text-[0.8125rem] font-medium">
            {`Local runtime: ${server.allowLocalRuntime ? "Allowed" : "Not allowed"}`}
          </p>
          <p className={`${smallClass} text-muted-foreground`}>
            <CodeText text="Set `FACTORY_ALLOW_LOCAL_RUNTIME` on the server and restart to change it." />
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Button type="submit" aria-disabled={pending || undefined}>
            {pending && <Loader2 aria-hidden="true" className="motion-safe:animate-spin" />}
            Save
          </Button>
          <InlineOutcome
            tone={outcome === "saved" ? "success" : outcome === "failed" ? "error" : undefined}
          >
            {outcome === "saved" ? "Saved." : "Couldn't save. Try again."}
          </InlineOutcome>
        </div>
      </fieldset>
    </form>
  );
}
