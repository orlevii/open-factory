import { ApiError, nameSchema, type ProjectSummary } from "@open-factory/shared";
import { useState } from "react";
import { FormField } from "@/components/form-field";
import { createProject } from "@/features/settings/api";
import { FormFrame, type FormFrameKind } from "./form-frame";
import { checkPath, fieldsOf, PATH_HELP } from "./shared";

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
  const [formError, setFormError] = useState<string>();
  const [pending, setPending] = useState(false);

  const checkName = (n: string) => {
    if (!nameSchema.safeParse(n).success) {
      return "Use 2–40 lowercase letters, numbers and inner hyphens, starting with a letter.";
    }
    return existing.includes(n) ? `A project named ${n} already exists.` : undefined;
  };
  const focus = (f: "name" | "hostPath") =>
    document.getElementById(f === "name" ? "field-project-name" : "field-project-path")?.focus();

  async function submit() {
    const found = { name: checkName(name), hostPath: checkPath(hostPath) };
    setErrors(found);
    setFormError(undefined);
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
        setFormError(
          err instanceof ApiError ? err.message : "Couldn't add the project. Try again.",
        );
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
      formError={formError}
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
      <FormField
        name="project-path"
        label="Path"
        help={PATH_HELP}
        error={errors.hostPath}
        value={hostPath}
        onChange={(e) => {
          setHostPath(e.target.value);
          setErrors((x) => ({ ...x, hostPath: undefined }));
        }}
        onBlur={() => setErrors((x) => ({ ...x, hostPath: checkPath(hostPath) }))}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        className="font-mono"
      />
    </FormFrame>
  );
}
