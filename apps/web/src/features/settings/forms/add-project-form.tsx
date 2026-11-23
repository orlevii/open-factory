import { ApiError, nameSchema, type ProjectSummary } from "@open-factory/shared";
import { useRef, useState } from "react";
import { FormField } from "@/components/form-field";
import { useOutcome } from "@/components/forms/form-outcome";
import { useFieldErrors } from "@/components/forms/use-field-errors";
import { createProject } from "@/features/settings/api";
import { FORM_MSG } from "@/lib/form-messages.ts";
import { FormFrame, type FormFrameKind } from "./form-frame";
import { checkPath, fieldsOf, PATH_HELP } from "./shared";

type Field = "name" | "hostPath";
const FIELDS: readonly Field[] = ["name", "hostPath"];

export function AddProjectForm({
  frame,
  existing,
  onDone,
  onCancel,
}: {
  frame: FormFrameKind;
  existing: string[];
  onDone(p: ProjectSummary): void;
  onCancel(): void;
}) {
  const [name, setName] = useState("");
  const [hostPath, setHostPath] = useState("");
  const o = useOutcome();
  const [pending, setPending] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const f = useFieldErrors({
    form: formRef,
    fields: FIELDS,
    checks: {
      name: () => {
        const r = nameSchema.safeParse(name);
        if (!r.success) return r.error.issues[0]?.message;
        return existing.includes(name) ? FORM_MSG.nameTaken : undefined;
      },
      hostPath: () => checkPath(hostPath),
    },
  });

  async function submit() {
    o.clear();
    if (!f.submit()) return;
    setPending(true);
    try {
      onDone(await createProject({ name, hostPath: hostPath.trim() }));
    } catch (err) {
      setPending(false);
      if (err instanceof ApiError && err.code === "project_exists")
        f.set("name", err.message, { focus: true });
      else if (!f.server(fieldsOf(err)))
        o.fail(err instanceof ApiError ? err.message : FORM_MSG.addProjectFailed);
    }
  }

  return (
    <FormFrame
      frame={frame}
      label="Add project"
      onSubmit={() => void submit()}
      onCancel={onCancel}
      submitLabel="Add project"
      pendingLabel="Adding…"
      pending={pending}
      outcome={o.outcome}
      ref={formRef}
    >
      <FormField
        name="project-name"
        label="Name"
        error={f.errors.name}
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          f.change("name");
        }}
        onBlur={(e) => f.blur("name", e)}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        className="font-mono"
      />
      <FormField
        name="project-path"
        label="Path"
        help={PATH_HELP}
        error={f.errors.hostPath}
        value={hostPath}
        onChange={(e) => {
          setHostPath(e.target.value);
          f.change("hostPath");
        }}
        onBlur={(e) => f.blur("hostPath", e)}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        className="font-mono"
      />
    </FormFrame>
  );
}
