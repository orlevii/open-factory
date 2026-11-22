import {
  ApiError,
  formatOffsetIso,
  isValidZone,
  parseAt,
  SCHEDULE_BODY_MAX,
  type ScheduleItem,
  validateCron,
} from "@open-factory/shared";
import { Link, useBlocker } from "@tanstack/react-router";
import {
  type FormEvent,
  type MutableRefObject,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { FieldShell } from "@/components/field-shell";
import { MarkdownEditor } from "@/components/markdown/markdown-editor";
import { Button } from "@/components/ui/button";
import { AgentPicker, agentOptionLabel, useAssignableAgents } from "@/features/tasks/agent-picker";
import type { CreateScheduleBody, PatchScheduleBody } from "./api";
import { browserZone } from "./format";
import { previewText, RunPreview } from "./run-preview";
import { TimezoneSelect } from "./timezone-select";
import { WhenField, type WhenMode } from "./when-field";

const FIELDS = ["target", "cron", "at", "timezone", "body"] as const;
type Field = (typeof FIELDS)[number];
type Errors = Partial<Record<Field, string>>;
const bytes = (s: string) => new TextEncoder().encode(s).length;

export type FormValues = {
  target: string;
  mode: WhenMode;
  cron: string;
  local: string;
  zone: string;
  body: string;
};

/** The edit page's start values: the stored instant read in the schedule's zone for the date input. */
export function valuesOf(s: ScheduleItem): FormValues {
  return {
    target: s.target.slug,
    mode: s.cron ? "repeats" : "once",
    cron: s.cron ?? "",
    local: s.at ? formatOffsetIso(new Date(s.at), s.timezone).slice(0, 16) : "",
    zone: s.timezone,
    body: s.body,
  };
}

/** A refreshed schedule's values: a field the user changed (differs from the previous base) is kept, the rest follow the server. */
export function mergeServer(
  prev: FormValues,
  prevBase: FormValues,
  server: FormValues,
): FormValues {
  const out = { ...prev };
  for (const k of Object.keys(server) as (keyof FormValues)[])
    if (prev[k] === prevBase[k]) out[k] = server[k] as never;
  return out;
}

/**
 * Create and edit (UI design §3). Each field validates when you leave it, never while you type; everything changed is
 * checked again on submit, which moves focus to the first invalid field. Edit sends only the fields that changed.
 */
export function ScheduleForm({
  initial,
  presetTarget,
  agentAuthored,
  readOnly,
  onSubmit,
  saved,
  cancelTo,
  afterMessage,
  leaving: leavingProp,
}: {
  initial?: ScheduleItem | undefined;
  presetTarget?: string | undefined;
  /** Edit: the body's author is an agent, so a changed message makes the editor its author. */
  agentAuthored?: boolean;
  readOnly?: boolean;
  onSubmit(body: CreateScheduleBody | PatchScheduleBody): Promise<void>;
  /** Edit: "Saved." after a successful save. */
  saved?: boolean;
  cancelTo?: string;
  afterMessage?: ReactNode;
  /** Set by the page once it has done something that leaves (a delete): the unsaved-changes guard then stays quiet. */
  leaving?: MutableRefObject<boolean>;
}) {
  // The start values are read once: valuesOf formats the instant, and browserZone asks Intl.
  const [start] = useState<FormValues>(() =>
    initial
      ? valuesOf(initial)
      : {
          target: presetTarget ?? "",
          mode: "repeats",
          cron: "",
          local: "",
          zone: browserZone(),
          body: "",
        },
  );
  const [v, setV] = useState<FormValues>(start);
  const base = useRef(start);
  const [errors, setErrors] = useState<Errors>({});
  const [preview, setPreview] = useState<string | undefined>(() =>
    initial
      ? previewText({ mode: start.mode, cron: start.cron, local: start.local, zone: start.zone })
      : undefined,
  );
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [toFocus, setToFocus] = useState<Field | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const ownLeaving = useRef(false);
  const leaving = leavingProp ?? ownLeaving;
  const { agents } = useAssignableAgents();
  const spawnedPicked = agents.find((a) => a.slug === v.target)?.kind === "ephemeral";

  // Live: a refreshed schedule updates the fields the user hasn't touched; edited fields are kept.
  const serverValues = useMemo(() => (initial ? JSON.stringify(valuesOf(initial)) : ""), [initial]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a change on the server counts
  useEffect(() => {
    if (!initial) return;
    const server = valuesOf(initial);
    const prevBase = base.current; // before the reassignment below
    base.current = server;
    setV((prev) => mergeServer(prev, prevBase, server));
    // The preview follows the fields it reads, so a server change to the timing doesn't leave it stale.
    const out = mergeServer(v, prevBase, server);
    setPreview(previewText({ mode: out.mode, cron: out.cron, local: out.local, zone: out.zone }));
  }, [serverValues]);

  const changed = (f: keyof FormValues) => v[f] !== base.current[f];
  const dirty = (Object.keys(v) as (keyof FormValues)[]).some(changed);
  useBlocker({
    shouldBlockFn: () => {
      if (leaving.current || !dirty || readOnly) return false;
      return !window.confirm("You have unsaved changes. Leave this page and discard them?");
    },
    enableBeforeUnload: () => dirty && !leaving.current && !readOnly,
  });

  const set = (patch: Partial<FormValues>) => setV((x) => ({ ...x, ...patch }));
  const setError = (f: Field, m: string | undefined) => setErrors((e) => ({ ...e, [f]: m }));
  const refresh = (o: Partial<FormValues> = {}) => {
    const x = { ...v, ...o };
    setPreview(previewText({ mode: x.mode, cron: x.cron, local: x.local, zone: x.zone }));
  };

  const check = {
    target: (x = v) => (x.target ? undefined : "Choose an agent."),
    cron: (x = v) => (!x.cron.trim() ? "Enter a pattern." : (validateCron(x.cron) ?? undefined)),
    at: (x = v) => {
      if (!x.local) return "Choose a date and time.";
      const at = parseAt(x.local, x.zone);
      if (!at) return "Choose a date and time.";
      return at.getTime() <= Date.now() ? "That time has passed." : undefined;
    },
    timezone: (x = v) => (isValidZone(x.zone) ? undefined : "Unknown time zone."),
    body: (x = v) =>
      !x.body.trim()
        ? "Enter a message."
        : bytes(x.body) > SCHEDULE_BODY_MAX
          ? "Shorten the message to 64 KB or less."
          : undefined,
  };

  const create = !initial;
  /** Fields that count on submit: everything on create; only what changed on edit. */
  const relevant = (f: Field): boolean => {
    if (create) return f === "cron" ? v.mode === "repeats" : f === "at" ? v.mode === "once" : true;
    const modeChanged = changed("mode");
    if (f === "target") return changed("target");
    if (f === "cron") return v.mode === "repeats" && (modeChanged || changed("cron"));
    if (f === "at")
      return v.mode === "once" && (modeChanged || changed("local") || changed("zone"));
    if (f === "timezone") return changed("zone");
    return changed("body");
  };

  function payload(): CreateScheduleBody | PatchScheduleBody {
    const out: Record<string, string> = {};
    if (create || changed("target")) out.target = v.target;
    if (create || relevant("cron")) if (v.mode === "repeats") out.cron = v.cron.trim();
    if ((create || relevant("at")) && v.mode === "once") out.at = v.local;
    if (create || changed("zone")) out.timezone = v.zone;
    if (create || changed("body")) out.body = v.body;
    return out as CreateScheduleBody;
  }

  const focus = (f: Field) =>
    form.current
      ?.querySelector<HTMLElement>(`#field-${f === "timezone" ? "timezone" : f}`)
      ?.focus();

  // biome-ignore lint/correctness/useExhaustiveDependencies: focus once, when asked for
  useEffect(() => {
    if (!toFocus) return;
    focus(toFocus);
    setToFocus(null);
  }, [toFocus]);

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    if (pending || readOnly) return;
    setFailed(false);
    const found: Errors = {};
    for (const f of FIELDS) if (relevant(f)) found[f] = check[f]();
    setErrors(found);
    const first = FIELDS.find((f) => found[f]);
    if (first) return focus(first);
    if (!create && !dirty) return;
    setPending(true);
    try {
      leaving.current = create; // a created schedule navigates away
      await onSubmit(payload());
      if (!create) setPending(false); // `base` follows the saved values through the refreshed `initial`
    } catch (err) {
      leaving.current = false;
      setPending(false);
      if (err instanceof ApiError) {
        const fields = (err.body.fields ?? {}) as Record<string, string>;
        const e: Errors = {};
        for (const f of FIELDS) if (fields[f]) e[f] = fields[f];
        if (Object.keys(e).length > 0) {
          setErrors(e);
          setToFocus(FIELDS.find((f) => e[f]) as Field); // once the fieldset is enabled again
          return;
        }
      }
      setFailed(true);
    }
  }

  return (
    <form ref={form} onSubmit={submit} noValidate className="grid max-w-[720px] gap-5">
      <fieldset disabled={pending || readOnly} className="grid min-w-0 gap-5">
        <FieldShell
          name="target"
          label="Target"
          error={errors.target}
          help={
            spawnedPicked
              ? "The schedule wakes this agent at each run. Spawned agents end when their work is done; this schedule is deleted with it."
              : "The schedule wakes this agent at each run."
          }
        >
          {(a) => (
            <AgentPicker
              id={a.id}
              value={v.target}
              describedBy={a.describedBy}
              placeholder="Choose an agent…"
              extraOption={
                initial && v.target === initial.target.slug
                  ? {
                      value: initial.target.slug,
                      label: `@${initial.target.slug} (${initial.target.terminated ? "terminated" : "archived"})`,
                    }
                  : undefined
              }
              onChange={(slug) => {
                set({ target: slug });
                setError("target", undefined);
              }}
            />
          )}
        </FieldShell>
        <WhenField
          mode={v.mode}
          onMode={(mode) => {
            set({ mode });
            setErrors((e) => ({ ...e, cron: undefined, at: undefined }));
            refresh({ mode });
          }}
          cron={v.cron}
          onCron={(cron) => {
            set({ cron });
            setError("cron", undefined);
          }}
          local={v.local}
          onLocal={(local) => {
            set({ local });
            setError("at", undefined);
          }}
          errors={errors}
          onBlurCron={() => {
            setError("cron", check.cron());
            refresh();
          }}
          onBlurLocal={() => {
            setError("at", check.at());
            refresh();
          }}
        />
        <FieldShell
          name="timezone"
          label="Time zone"
          error={errors.timezone}
          help="Times are read and shown in this zone."
        >
          {(a) => (
            <TimezoneSelect
              id={a.id}
              value={v.zone}
              describedBy={a.describedBy}
              invalid={a.invalid}
              onChange={(zone) => {
                set({ zone });
                setError("timezone", undefined);
                refresh({ zone });
              }}
              onBlur={() => setError("timezone", check.timezone())}
            />
          )}
        </FieldShell>
        <RunPreview text={preview} />
        <FieldShell
          name="body"
          label="Message"
          error={errors.body}
          help={
            create
              ? "Delivered as written, from @scheduler, with you as its author."
              : agentAuthored
                ? "Saving a changed message makes you its author."
                : "Delivered as written, from @scheduler."
          }
        >
          {(a) => (
            <MarkdownEditor
              id={a.id}
              value={v.body}
              onChange={(body) => {
                set({ body });
                setError("body", undefined);
              }}
              onBlur={() => setError("body", check.body())}
              {...(a.describedBy ? { "aria-describedby": a.describedBy } : {})}
            />
          )}
        </FieldShell>
        {afterMessage}
        {failed && (
          <p role="alert" className="text-[0.8125rem] leading-[1.125rem] text-destructive">
            Couldn't save the schedule. Try again.
          </p>
        )}
        {!readOnly && (
          <div className="flex items-center gap-2">
            <Button type="submit" disabled={pending}>
              {create
                ? pending
                  ? "Creating…"
                  : "Create schedule"
                : pending
                  ? "Saving…"
                  : "Save changes"}
            </Button>
            <Button type="button" variant="outline" asChild>
              <Link to={cancelTo ?? "/schedules"} search={{}}>
                Cancel
              </Link>
            </Button>
            {saved && !dirty && !pending && (
              <span role="status" className="text-[0.8125rem] text-muted-foreground">
                Saved.
              </span>
            )}
          </div>
        )}
      </fieldset>
    </form>
  );
}
export { agentOptionLabel };
