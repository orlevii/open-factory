import { ApiError, nameSchema, type ProjectSummary } from "@open-factory/shared";
import { useState } from "react";
import { FormField } from "@/components/form-field";
import { useOutcome } from "@/components/forms/form-outcome";
import { checkHostPath, PathField } from "@/components/path-field";
import { createProject } from "@/features/settings/api";
import { FORM_MSG } from "@/lib/form-messages.ts";
import { FormFrame, type FormFrameKind } from "./form-frame";
import { fieldsOf } from "./shared";

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
  const [errors, setErrors] = useState<{ name?: string; hostPath?: string }>({});
  const o = useOutcome();
  const [pending, setPending] = useState(false);

  const checkName = (n: string) => {
    const r = nameSchema.safeParse(n);
    if (!r.success) return r.error.issues[0]?.message;
    return existing.includes(n) ? FORM_MSG.nameTaken : undefined;
  };
  const focus = (f: "name" | "hostPath") =>
    document.getElementById(f === "name" ? "field-project-name" : "field-project-path")?.focus();

  async function submit() {
    const found = { name: checkName(name), hostPath: checkHostPath(hostPath) };
    setErrors(found);
    o.clear();
    if (found.name || found.hostPath) return focus(found.name ? "name" : "hostPath");
    setPending(true);
    try {
      onDone(await createProject({ name, hostPath: hostPath.trim() }));
    } catch (err) {
      const fields = fieldsOf(err);
      if (err instanceof ApiError && err.code === "project_exists") {
        setErrors({ name: err.message });
        focus("name");
      } else if (fields && (fields.name || fields.hostPath)) {
        setErrors({ name: fields.name, hostPath: fields.hostPath });
        focus(fields.name ? "name" : "hostPath");
      } else {
        o.fail(err instanceof ApiError ? err.message : "Couldn't add the project. Try again.");
      }
    } finally {
      setPending(false);
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
    >
      <FormField
        name="project-name"
        label="Name"
        error={errors.name}
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setErrors((x) => ({ ...x, name: undefined }));
        }}
        onBlur={() => setErrors((x) => ({ ...x, name: checkName(name) }))}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        className="font-mono"
      />
      <PathField
        name="project-path"
        label="Path"
        help="A folder on the factory's machine, like ~/code/web."
        error={errors.hostPath}
        value={hostPath}
        onChange={(e) => {
          setHostPath(e.target.value);
          setErrors((x) => ({ ...x, hostPath: undefined }));
        }}
        onBlur={() => setErrors((x) => ({ ...x, hostPath: checkHostPath(hostPath) }))}
      />
    </FormFrame>
  );
}
