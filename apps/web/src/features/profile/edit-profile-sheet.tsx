import { ApiError, handleSchema, patchMeBodySchema } from "@open-factory/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { FormField } from "@/components/form-field";
import { useOutcome } from "@/components/forms/form-outcome";
import { useFieldErrors } from "@/components/forms/use-field-errors";
import { SheetBody } from "@/components/ui/sheet";
import { notify } from "@/components/ui/toaster";
import { useHandleTaken } from "@/features/principals/use-handle-taken";
import { useFocusOnOpen } from "@/features/sheets/focus-on-open";
import { SheetFormFooter } from "@/features/sheets/form-footer";
import type { BodyProps } from "@/features/sheets/sheet-bodies";
import { FORM_MSG } from "@/lib/form-messages.ts";
import { sessionQueryOptions } from "@/lib/session";
import { applyMe, patchMe, undoRename } from "./api";

const FIELDS = ["name", "handle"] as const;
type Field = (typeof FIELDS)[number];

/** The Edit profile sheet body (§4.5): the signed-in person's Name and Handle. */
export default function EditProfileSheet({ close }: BodyProps<{ kind: "edit-profile" }>) {
  const qc = useQueryClient();
  const me = useQuery(sessionQueryOptions).data?.user;
  if (!me) return null;
  return <ProfileForm key={me.ref} close={close} me={me} qc={qc} />;
}

function ProfileForm({
  me,
  close,
  qc,
}: {
  me: { ref: string; name: string; handle: string };
  close(): void;
  qc: ReturnType<typeof useQueryClient>;
}) {
  const form = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState({ name: me.name, handle: me.handle });
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const o = useOutcome();
  const taken = useHandleTaken(me.ref);

  const f = useFieldErrors<Field>({
    form,
    fields: FIELDS,
    checks: {
      name: () => {
        const r = patchMeBodySchema.shape.name.safeParse(values.name);
        return r.success ? undefined : r.error.issues[0]?.message;
      },
      handle: () => {
        const r = handleSchema.safeParse(values.handle);
        return r.success ? taken(values.handle) : r.error.issues[0]?.message;
      },
    },
  });
  useFocusOnOpen(form);

  const set = (field: Field, value: string) => {
    setValues((v) => ({ ...v, [field]: value }));
    f.change(field);
    o.clear();
  };

  async function submit() {
    if (inFlight.current) return;
    o.clear();
    if (!f.submit()) return;
    const name = values.name.trim();
    const body = {
      ...(name !== me.name ? { name } : {}),
      ...(values.handle !== me.handle ? { handle: values.handle } : {}),
    };
    if (Object.keys(body).length === 0) {
      o.succeed("Nothing to save: no field changed.");
      return;
    }
    inFlight.current = true;
    setPending(true);
    try {
      const saved = await patchMe(body);
      applyMe(qc, saved);
      close();
      if (body.handle !== undefined)
        notify({
          text: `@${me.handle} is now @${saved.handle}`,
          undo: () =>
            undoRename(me.handle, async (handle) => applyMe(qc, await patchMe({ handle }))),
        });
      else notify({ text: "Saved your profile." });
    } catch (err) {
      if (!(err instanceof ApiError)) o.fail(FORM_MSG.unreachable);
      else if (!f.server(err.body.fields as Record<string, string> | undefined))
        o.fail(err.message);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <form
      ref={form}
      aria-label="Edit profile"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <SheetBody className="field-stack content-start">
        <fieldset disabled={pending} className="field-stack">
          <legend className="sr-only">Edit profile</legend>
          <FormField
            name="name"
            label="Name"
            autoComplete="name"
            value={values.name}
            error={f.errors.name}
            onChange={(e) => set("name", e.target.value)}
            onBlur={(e) => f.blur("name", e)}
          />
          <FormField
            name="handle"
            label="Handle"
            prefix="@"
            help="How agents and people tag you, like @alice."
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="font-mono"
            value={values.handle}
            error={f.errors.handle}
            onChange={(e) => set("handle", e.target.value.toLowerCase())}
            onBlur={(e) => f.blur("handle", e)}
          />
        </fieldset>
      </SheetBody>
      <SheetFormFooter
        submitLabel="Save changes"
        pendingLabel="Saving…"
        pending={pending}
        restored={false}
        onDiscard={() => {}}
        submitClassName="min-w-32"
        outcome={o.outcome}
      />
    </form>
  );
}
