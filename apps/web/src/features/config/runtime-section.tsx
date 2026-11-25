import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { FieldShell } from "@/components/field-shell";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { factorySettingsQueryOptions } from "@/features/settings/api";
import { FIELD_PATHS } from "./fields";
import { imageNote, RUNTIME_COPY } from "./messages";
import { useConfigScope, useFieldNote } from "./scope";
import { Section, WrongType } from "./section";
import { readAt, readString } from "./tolerant";

const RUNTIMES = [
  { value: "docker", label: "Docker" },
  { value: "local", label: "Local" },
] as const;

/**
 * Spec §2.3, template mode only: where agents run, which image, and how Claude Code asks for permission. Local is
 * `aria-disabled` (focusable, described) when the factory refuses it; Bypass needs Docker. A stored value that has
 * become invalid stays selected with its error, never silently flipped.
 */
export function RuntimeSection() {
  const s = useConfigScope();
  const factory = useQuery(factorySettingsQueryOptions).data;
  const runtime = useFieldNote("runtime");
  const image = useFieldNote("image");
  const mode = useFieldNote("permissionMode");
  const ids = { runtime: useId(), image: useId(), permission: useId() };
  // The note that Bypass was switched to Auto belongs to the Local pick that caused it.
  const [switched, setSwitched] = useState(false);

  const runtimeRead = readString(readAt(s.value, FIELD_PATHS.runtime));
  const modeRead = readString(readAt(s.value, FIELD_PATHS.permissionMode));
  const imageRead = readString(readAt(s.value, FIELD_PATHS.image));
  // A value of the wrong type (Raw JSON made it) shows "Edit this in Raw JSON." on its own field only.
  const runtimeValue = (runtimeRead.ok && runtimeRead.value) || "docker";
  const modeValue = (modeRead.ok && modeRead.value) || "auto";
  const imageValue = (imageRead.ok && imageRead.value) || "";
  const local = runtimeValue === "local";
  const localRefused = factory?.allowLocalRuntime === false;
  const { fieldErrors, readOnly, update } = s;

  const chooseRuntime = (v: "docker" | "local") => {
    if (readOnly) return;
    update(FIELD_PATHS.runtime, () => v);
    if (v === "local" && modeValue === "bypass") {
      update(FIELD_PATHS.permissionMode, () => "auto");
      setSwitched(true);
    } else if (v === "docker") setSwitched(false);
  };

  const runtimeHelp = localRefused
    ? `${RUNTIME_COPY.runtimeNote}. ${RUNTIME_COPY.localDisabled}`
    : RUNTIME_COPY.runtimeNote;
  // A hand-written `local` on a factory that refuses it stays selected, with the reason as its error.
  const runtimeError =
    runtime.error && local && localRefused
      ? `${runtime.error} ${RUNTIME_COPY.localDisabled}`
      : (runtime.error ?? (local && localRefused ? RUNTIME_COPY.localDisabled : undefined));
  const permissionHelp = local
    ? switched
      ? RUNTIME_COPY.switchedToAuto
      : RUNTIME_COPY.bypassNeedsDocker
    : RUNTIME_COPY.permissionNote;

  return (
    <Section title="Runtime">
      {runtimeRead.ok ? (
        <FieldShell
          name="runtime"
          label="Runtime"
          plainLabel
          help={runtimeHelp}
          error={runtimeError}
          warning={localRefused ? undefined : runtime.warning}
        >
          {({ id, describedBy }) => (
            <SegmentedControl
              legend="Runtime"
              name={ids.runtime}
              value={runtimeValue}
              describedBy={describedBy}
              options={RUNTIMES.map((o) =>
                o.value === "local" && localRefused
                  ? {
                      ...o,
                      unavailable: true,
                      describedBy: `${id}-${runtimeError ? "error" : "help"}`,
                    }
                  : o,
              )}
              onChange={chooseRuntime}
            />
          )}
        </FieldShell>
      ) : (
        <WrongType field="runtime" label="Runtime" />
      )}
      {imageRead.ok ? (
        <FieldShell
          name="image"
          label="Image"
          help={local ? RUNTIME_COPY.imageNotUsed : imageNote(factory?.defaultImage)}
          error={image.error}
          warning={image.warning}
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              value={imageValue}
              disabled={local}
              readOnly={readOnly}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              onChange={(e) => {
                fieldErrors.change("image");
                const t = e.target.value;
                update(FIELD_PATHS.image, () => (t === "" ? undefined : t));
              }}
              onBlur={(e) => fieldErrors.blur("image", e)}
            />
          )}
        </FieldShell>
      ) : (
        <WrongType field="image" label="Image" />
      )}
      {modeRead.ok ? (
        <FieldShell
          name="permissionMode"
          label="Permission mode"
          plainLabel
          help={permissionHelp}
          error={mode.error}
          warning={mode.warning}
        >
          {({ describedBy }) => (
            <SegmentedControl
              legend="Permission mode"
              name={ids.permission}
              value={modeValue}
              describedBy={describedBy}
              options={[
                { value: "auto", label: "Auto" },
                {
                  value: "bypass",
                  label: "Bypass",
                  ...(local ? { unavailable: true, describedBy } : {}),
                },
              ]}
              onChange={(v) => {
                if (readOnly) return;
                update(FIELD_PATHS.permissionMode, () => v);
              }}
            />
          )}
        </FieldShell>
      ) : (
        <WrongType field="permissionMode" label="Permission mode" />
      )}
    </Section>
  );
}
