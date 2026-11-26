import {
  ApiError,
  formatOffsetIso,
  isValidZone,
  MSG,
  parseAt,
  SCHEDULE_BODY_MAX,
  type ScheduleItem,
  validateCron,
} from "@open-factory/shared";
import { useQuery } from "@tanstack/react-query";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { FieldShell } from "@/components/field-shell";
import { useOutcome } from "@/components/forms/form-outcome";
import { useFieldErrors } from "@/components/forms/use-field-errors";
import { MarkdownEditor } from "@/components/markdown/markdown-editor";
import { SheetBody } from "@/components/ui/sheet";
import { AgentCombobox } from "@/features/agents/agent-combobox";
import { agentsListQueryOptions } from "@/features/session/api";
import { useSheetDraft } from "@/features/sheets/drafts";
import { useFocusOnOpen } from "@/features/sheets/focus-on-open";
import { SheetFormFooter } from "@/features/sheets/form-footer";
import { mergeServer } from "@/features/sheets/merge-server";
import { useAssignableAgents } from "@/features/tasks/agent-picker";
import { FORM_MSG } from "@/lib/form-messages.ts";
import type { CreateScheduleBody, PatchScheduleBody } from "./api";
import { browserZone } from "./format";
import { type Preview, previewOf, RunPreview } from "./run-preview";
import { TimezoneSelect } from "./timezone-select";
import { WhenField, type WhenMode } from "./when-field";

const FIELDS = ["target", "cron", "at", "timezone", "body"] as const;
type Field = (typeof FIELDS)[number];
const bytes = (s: string) => new TextEncoder().encode(s).length;

type FormValues = {
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
function valuesOf(s: ScheduleItem): FormValues {
  return {
    target: s.target.ref,
    mode: s.cron ? "repeats" : "once",
    cron: s.cron ?? "",
    local: s.at ? formatOffsetIso(new Date(s.at), s.timezone).slice(0, 16) : "",
    zone: s.timezone,
    body: s.body,
  };
}

/**
 * Create and edit, always in a sheet (§9). Validation timing and focus belong to `useFieldErrors`: a changed field
 * validates when you leave it, never while you type; the submit checks every field on create and only the changed ones
 * on edit, and moves focus to the first invalid field. Edit sends only the fields that changed. The values live in a
 * draft (`new-schedule`, or `edit-schedule:<key>` holding `{ values, base }`).
 */
export function ScheduleForm({
  initial,
  presetTarget,
  agentAuthored,
  onSubmit,
  lead,
  footerLeft,
  locked,
}: {
  initial?: ScheduleItem | undefined;
  presetTarget?: string | undefined;
  /** Edit: the body's author is an agent, so a changed message makes the editor its author. */
  agentAuthored?: boolean;
  onSubmit(body: CreateScheduleBody | PatchScheduleBody): Promise<void>;
  /** Above the first field, inside the scrolling body (the edit sheet's state line). */
  lead?: ReactNode;
  /** The footer's left side (the edit sheet's Delete). */
  footerLeft?: (pending: boolean) => ReactNode;
  /** Another action (Delete) is in flight: Save waits. */
  locked?: boolean;
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
  const [preview, setPreview] = useState<Preview | undefined>(() =>
    initial
      ? previewOf({
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
      previewOf({ mode: merged.mode, cron: merged.cron, local: merged.local, zone: merged.zone }),
    );
  }

  const [pending, setPending] = useState(false);
  const o = useOutcome();
  const form = useRef<HTMLFormElement>(null);
  useFocusOnOpen(form);
  const { agents } = useAssignableAgents();
  // An archived or terminated target isn't a live option: while it is the value, the trigger names it.
  const endedTarget =
    initial &&
    v.target === initial.target.ref &&
    (initial.target.archived || initial.target.terminated)
      ? initial.target
      : undefined;
  const renderEndedTarget = useMemo(
    () =>
      endedTarget
        ? () => `@${endedTarget.handle} (${endedTarget.terminated ? "terminated" : "archived"})`
        : undefined,
    [endedTarget],
  );
  const spawnedPicked = agents.find((a) => a.ref === v.target)?.kind === "ephemeral";

  // A stale preset cleared is not an edit: the cleared form becomes the untouched baseline, so closing leaves no draft
  // and the next preset still applies. `draft.rebase` writes a ref, so it runs in an effect, not in the render that
  // clears the field (set there, further down), and before the draft save below, so that save compares with the new
  // baseline. `restored` is the form's own state, so after Discard the preset counts as a fresh one.
  const [rebaseStale, setRebaseStale] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `draft.rebase` and `blank` only write the draft's ref
  useEffect(() => {
    if (!rebaseStale) return;
    setRebaseStale(false);
    draft.rebase({ ...blank(), target: "" });
  }, [rebaseStale]);

  // An effect, not a write in each setter: the many field handlers all go through `v`, and the draft only has to be
  // current when the sheet closes. An untouched form (equal to its start values, or to its base) holds no draft.
  const { save: saveDraft } = draft;
  // Not after a successful submit: the refreshed copy changes `base` and would write the draft back.
  const submitted = useRef(false);
  useEffect(() => {
    if (!submitted.current) saveDraft(create ? v : { values: v, base });
  }, [create, saveDraft, v, base]);

  const checks = {
    target: () => (v.target ? undefined : FORM_MSG.chooseAgent),
    cron: () => (!v.cron.trim() ? FORM_MSG.enterPattern : (validateCron(v.cron) ?? undefined)),
    at: () => {
      const at = v.local ? parseAt(v.local, v.zone) : undefined;
      if (!at) return FORM_MSG.chooseTime;
      return at.getTime() <= Date.now() ? FORM_MSG.timePassed : undefined;
    },
    // No blur: the zone is picked from a list, so only a restored draft can hold a bad one, and the submit says so.
    timezone: () => (isValidZone(v.zone) ? undefined : FORM_MSG.unknownZone),
    body: () =>
      !v.body.trim()
        ? FORM_MSG.enterMessage
        : bytes(v.body) > SCHEDULE_BODY_MAX
          ? MSG.bodyTooLong
          : undefined,
  };
  const f = useFieldErrors<Field>({ form, fields: FIELDS, checks });

  // The Message textarea exists only in Write, and its tab panel mounts a commit after the switch, too late for the
  // hook's focus: a failing submit switches to Write and the textarea takes focus when it mounts.
  const [bodyView, setBodyView] = useState<"write" | "preview">("write");
  const focusBody = useRef(false);
  const focusBodyOnMount = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el || !focusBody.current) return;
    focusBody.current = false;
    el.focus();
  }, []);

  // A draft or link may name an agent that has since ended or never existed: clear it, with the reason under Target,
  // set during render so it shows in the commit that empties the field.
  const live = useQuery({ ...agentsListQueryOptions("exclude"), enabled: create });
  const endedList = useQuery({ ...agentsListQueryOptions("only"), enabled: create });
  if (
    create &&
    v.target &&
    live.data &&
    endedList.data &&
    !live.data.some((a) => a.ref === v.target && !a.archivedAt && !a.terminatedAt)
  ) {
    const gone = v.target;
    const hasEnded = [...live.data, ...endedList.data].some((a) => a.ref === gone);
    if (!restored && gone === presetTarget) setRebaseStale(true);
    setV((x) => ({ ...x, target: "" }));
    const staleError = hasEnded ? FORM_MSG.agentEnded : FORM_MSG.agentMissing;
    // Guarded, not left to the updater's bail-out: any setState call during render schedules another render.
    if (f.errors.target !== staleError) f.set("target", staleError);
  }

  const changed = (k: keyof FormValues) => v[k] !== base[k];
  const dirty = (Object.keys(v) as (keyof FormValues)[]).some(changed);

  const set = (patch: Partial<FormValues>) => setV((x) => ({ ...x, ...patch }));
  const refresh = (patch: Partial<FormValues> = {}) => {
    const x = { ...v, ...patch };
    setPreview(previewOf({ mode: x.mode, cron: x.cron, local: x.local, zone: x.zone }));
  };

  /** Fields that count on submit: everything on create; only what changed on edit. */
  const relevant = (k: Field): boolean => {
    if (create) return k === "cron" ? v.mode === "repeats" : k === "at" ? v.mode === "once" : true;
    const modeChanged = changed("mode");
    if (k === "target") return changed("target");
    if (k === "cron") return v.mode === "repeats" && (modeChanged || changed("cron"));
    if (k === "at")
      return v.mode === "once" && (modeChanged || changed("local") || changed("zone"));
    if (k === "timezone") return changed("zone");
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

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    if (pending || locked) return;
    o.clear();
    const toCheck = FIELDS.filter(relevant);
    if (bodyView === "preview" && toCheck.includes("body") && checks.body()) {
      setBodyView("write");
      // Message is the last field: it takes focus only when nothing above it fails too.
      focusBody.current = toCheck.every((k) => k === "body" || !checks[k]());
    }
    if (!f.submit(toCheck)) return;
    if (!create && !dirty) return;
    setPending(true);
    try {
      await onSubmit(payload());
      submitted.current = true;
      if (!create) setPending(false); // `base` follows the saved values through the refreshed `initial`
    } catch (err) {
      const fields =
        err instanceof ApiError
          ? (err.body.fields as Record<string, string> | undefined)
          : undefined;
      // Re-enabled in the commit that focuses the field.
      setPending(false);
      if (!f.server(fields)) o.fail(FORM_MSG.saveScheduleFailed);
    }
  }

  const fields = (
    <fieldset disabled={pending || locked} className="field-stack">
      <FieldShell
        name="target"
        label="Target"
        error={f.errors.target}
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
            onValueChange={(agentRef) => {
              set({ target: agentRef ?? "" });
              f.change("target");
            }}
          />
        )}
      </FieldShell>
      <WhenField
        mode={v.mode}
        onMode={(mode) => {
          set({ mode });
          refresh({ mode });
        }}
        cron={v.cron}
        onCron={(cron) => {
          set({ cron });
          f.change("cron");
        }}
        local={v.local}
        onLocal={(local) => {
          set({ local });
          f.change("at");
        }}
        errors={f.errors}
        onBlurCron={(e) => {
          f.blur("cron", e);
          refresh();
        }}
        onBlurLocal={(e) => {
          f.blur("at", e);
          refresh();
        }}
        onPreset={(cron) => {
          set({ cron });
          f.change("cron");
          refresh({ cron });
        }}
        zone={v.zone}
        preview={<RunPreview preview={preview} />}
      />
      <FieldShell
        name="timezone"
        label="Time zone"
        error={f.errors.timezone}
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
              f.change("timezone");
              refresh({ zone });
            }}
          />
        )}
      </FieldShell>
      {v.mode === "once" && <RunPreview preview={preview} />}
      <FieldShell
        name="body"
        label="Message"
        error={f.errors.body}
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
            invalid={Boolean(f.errors.body)}
            view={bodyView}
            onViewChange={setBodyView}
            textareaRef={focusBodyOnMount}
            onChange={(body) => {
              set({ body });
              f.change("body");
            }}
            onBlur={(e) => f.blur("body", e)}
            {...(a.describedBy ? { "aria-describedby": a.describedBy } : {})}
          />
        )}
      </FieldShell>
    </fieldset>
  );

  return (
    <form ref={form} onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
      <SheetBody className="field-stack">
        {lead}
        {fields}
      </SheetBody>
      <SheetFormFooter
        outcome={o.outcome}
        submitLabel={create ? "Create schedule" : "Save changes"}
        pendingLabel={create ? "Creating…" : "Saving…"}
        pending={pending}
        restored={restored}
        left={footerLeft?.(pending)}
        onDiscard={() => {
          draft.clear();
          const fresh = server ?? blank();
          setV(fresh);
          f.reset();
          o.clear();
          setPreview(
            initial
              ? previewOf({
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
