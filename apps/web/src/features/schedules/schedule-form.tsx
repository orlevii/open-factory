import {
  ApiError,
  formatOffsetIso,
  isValidZone,
  parseAt,
  SCHEDULE_BODY_MAX,
  type ScheduleItem,
  validateCron,
} from "@open-factory/shared";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { FieldShell } from "@/components/field-shell";
import { MarkdownEditor } from "@/components/markdown/markdown-editor";
import { SheetBody } from "@/components/ui/sheet";
import { AgentCombobox } from "@/features/agents/agent-combobox";
import { agentsListQueryOptions } from "@/features/session/api";
import { useSheetDraft } from "@/features/sheets/drafts";
import { SheetFormFooter } from "@/features/sheets/form-footer";
import { mergeServer } from "@/features/sheets/merge-server";
import { agentOptionLabel, useAssignableAgents } from "@/features/tasks/agent-picker";
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

/** An edit draft holds the values and the server copy they were edited against (§5.5). */
type EditDraft = { values: FormValues; base: FormValues };

/** The edit sheet's start values: the stored instant read in the schedule's zone for the date input. */
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

/**
 * Create and edit, always in a sheet (§9). Each field validates when you leave it, never while you type; everything
 * changed is checked again on submit, which moves focus to the first invalid field. Edit sends only the fields that
 * changed. The values live in a draft (`new-schedule`, or `edit-schedule:<key>` holding `{ values, base }`).
 */
export function ScheduleForm({
  initial,
  presetTarget,
  agentAuthored,
  onSubmit,
  lead,
  footerLeft,
}: {
  initial?: ScheduleItem | undefined;
  presetTarget?: string | undefined;
  /** Edit: the body's author is an agent, so a changed message makes the editor its author. */
  agentAuthored?: boolean;
  onSubmit(body: CreateScheduleBody | PatchScheduleBody): Promise<void>;
  /** Above the first field, inside the scrolling body (the edit sheet's state line). */
  lead?: ReactNode;
  /** The footer's left side (the edit sheet's Delete). */
  footerLeft?: ReactNode;
}) {
  const create = !initial;
  const blank = (): FormValues => ({
    target: presetTarget ?? "",
    mode: "repeats",
    cron: "",
    local: "",
    zone: browserZone(),
    body: "",
  });
  // The server copy as form values; a new identity only when the schedule itself changed.
  const server = useMemo(() => (initial ? valuesOf(initial) : undefined), [initial]);
  const draft = useSheetDraft<FormValues | EditDraft>(
    initial ? `edit-schedule:${initial.key}` : "new-schedule",
    () => (server ? { values: server, base: server } : blank()),
  );
  const [restored, setRestored] = useState(draft.restored);
  // The start values are read once. A restored edit draft starts from its values merged onto the server copy as it is now.
  const [start] = useState<EditDraft>(() => {
    if (!server) return { values: draft.start as FormValues, base: draft.start as FormValues };
    const d = draft.start as EditDraft;
    return { values: mergeServer(d.values, d.base, server), base: server };
  });
  const [v, setV] = useState<FormValues>(start.values);
  /** The server copy the values were edited against; a field equal to it is untouched. */
  const [base, setBase] = useState<FormValues>(start.base);
  const [errors, setErrors] = useState<Errors>({});
  const [preview, setPreview] = useState<string | undefined>(() =>
    initial
      ? previewText({
          mode: start.values.mode,
          cron: start.values.cron,
          local: start.values.local,
          zone: start.values.zone,
        })
      : undefined,
  );
  // Live: a refreshed schedule updates the fields the user hasn't touched; edited fields are kept. Adjusted while
  // rendering (a new server copy is a new prop), so the form never paints the stale merge.
  if (server && server !== base) {
    const merged = mergeServer(v, base, server);
    setV(merged);
    setBase(server);
    setPreview(
      previewText({ mode: merged.mode, cron: merged.cron, local: merged.local, zone: merged.zone }),
    );
  }

  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [toFocus, setToFocus] = useState<Field | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const { agents } = useAssignableAgents();
  // An archived or terminated target isn't a live option: while it is the value, the trigger names it.
  const endedTarget =
    initial &&
    v.target === initial.target.slug &&
    (initial.target.archived || initial.target.terminated)
      ? initial.target
      : undefined;
  const renderEndedTarget = useMemo(
    () =>
      endedTarget
        ? () => `@${endedTarget.slug} (${endedTarget.terminated ? "terminated" : "archived"})`
        : undefined,
    [endedTarget],
  );
  const spawnedPicked = agents.find((a) => a.slug === v.target)?.kind === "ephemeral";

  // An effect, not a write in each setter: the many field handlers all go through `v`, and the draft only has to be
  // current when the sheet closes. An untouched form (equal to its start values, or to its base) holds no draft.
  const { save: saveDraft } = draft;
  useEffect(() => {
    saveDraft(create ? v : { values: v, base });
  }, [create, saveDraft, v, base]);

  // A draft or link may name an agent that has since ended or never existed: clear it, with the reason under Target.
  const live = useQuery({ ...agentsListQueryOptions("exclude"), enabled: create });
  const endedList = useQuery({ ...agentsListQueryOptions("only"), enabled: create });
  if (
    create &&
    v.target &&
    live.data &&
    endedList.data &&
    !live.data.some((a) => a.slug === v.target && !a.archivedAt && !a.terminatedAt)
  ) {
    const gone = v.target;
    const hasEnded = [...live.data, ...endedList.data].some((a) => a.slug === gone);
    setV((x) => ({ ...x, target: "" }));
    setErrors((e) => ({
      ...e,
      target: hasEnded ? `@${gone} has ended; pick another.` : `There is no agent @${gone}.`,
    }));
  }

  const changed = (f: keyof FormValues) => v[f] !== base[f];
  const dirty = (Object.keys(v) as (keyof FormValues)[]).some(changed);

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
    if (pending) return;
    setFailed(false);
    const found: Errors = {};
    for (const f of FIELDS) if (relevant(f)) found[f] = check[f]();
    setErrors(found);
    const first = FIELDS.find((f) => found[f]);
    if (first) return focus(first);
    if (!create && !dirty) return;
    setPending(true);
    try {
      await onSubmit(payload());
      if (!create) setPending(false); // `base` follows the saved values through the refreshed `initial`
    } catch (err) {
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

  const fields = (
    <fieldset disabled={pending} className="grid min-w-0 gap-5">
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
          <AgentCombobox
            id={a.id}
            aria-label="Target"
            scope="live"
            placeholder="Choose an agent…"
            value={v.target || null}
            aria-invalid={a.invalid || undefined}
            aria-describedby={a.describedBy}
            renderValue={renderEndedTarget}
            onValueChange={(slug) => {
              set({ target: slug ?? "" });
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
        onPreset={(cron) => {
          set({ cron });
          setError("cron", undefined);
          refresh({ cron });
        }}
        zone={v.zone}
        preview={<RunPreview text={preview} />}
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
      {v.mode === "once" && <RunPreview text={preview} />}
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
            proportional
            onChange={(body) => {
              set({ body });
              setError("body", undefined);
            }}
            onBlur={() => setError("body", check.body())}
            {...(a.describedBy ? { "aria-describedby": a.describedBy } : {})}
          />
        )}
      </FieldShell>
      {failed && (
        <p role="alert" className="text-[0.8125rem] leading-[1.125rem] text-destructive">
          Couldn't save the schedule. Try again.
        </p>
      )}
    </fieldset>
  );

  return (
    <form ref={form} onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
      <SheetBody className="grid content-start gap-5">
        {lead}
        {fields}
      </SheetBody>
      <SheetFormFooter
        submitLabel={create ? "Create schedule" : "Save changes"}
        pendingLabel={create ? "Creating…" : "Saving…"}
        pending={pending}
        restored={restored}
        left={footerLeft}
        onDiscard={() => {
          draft.clear();
          const fresh = server ?? blank();
          setV(fresh);
          setErrors({});
          setPreview(
            initial
              ? previewText({
                  mode: fresh.mode,
                  cron: fresh.cron,
                  local: fresh.local,
                  zone: fresh.zone,
                })
              : undefined,
          );
          setRestored(false);
        }}
      />
    </form>
  );
}
export { agentOptionLabel };
