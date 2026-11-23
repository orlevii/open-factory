import { MODEL_ALIASES, MODEL_IDS, MODEL_MSG } from "@open-factory/shared";
import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { FieldShell } from "@/components/field-shell";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CONFIG_COPY } from "./messages";
import { useFieldNote } from "./scope";
import { OverrideAction, WrongType } from "./section";
import { readString } from "./tolerant";
import { INHERIT, useScalar } from "./use-scalar";

const CUSTOM = "__custom";
const KNOWN: ReadonlySet<string> = new Set<string>([...MODEL_ALIASES, ...MODEL_IDS]);

/** The model picker (spec §12.3): inherit, the aliases, the model ids, then Custom… with a checked mono input. */
export function ModelField() {
  const { scope, own, inherited, inherits, overridden, set } = useScalar("model");
  const note = useFieldNote("model");
  const [customOpen, setCustomOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const custom = useRef<HTMLInputElement>(null);
  // Set when Custom… is picked: the Select's close then focuses the new input instead of its trigger.
  const focusCustom = useRef(false);

  const r = readString(own);
  if (!r.ok) return <WrongType field="model" label="Model" />;
  const model = r.value;
  const showCustom = customOpen || (model !== undefined && !KNOWN.has(model));
  const selected = showCustom ? CUSTOM : (model ?? INHERIT);
  const help = inherits
    ? `From template: ${typeof inherited === "string" ? inherited : CONFIG_COPY.inheritTemplate}`
    : undefined;
  const { fieldErrors, readOnly } = scope;

  const choose = (v: string) => {
    fieldErrors.change("model");
    if (v === CUSTOM) {
      focusCustom.current = true;
      flushSync(() => setCustomOpen(true));
      return;
    }
    setCustomOpen(false);
    set(v === INHERIT ? undefined : v);
  };

  const inheritAgain = () => {
    fieldErrors.change("model");
    flushSync(() => {
      setCustomOpen(false);
      set(undefined);
    });
    trigger.current?.focus();
  };

  return (
    <div className="grid gap-2">
      <FieldShell
        name="model"
        label="Model"
        help={help}
        error={showCustom ? undefined : note.error}
        warning={note.warning}
        action={
          overridden && !readOnly ? <OverrideAction what="model" onUse={inheritAgain} /> : undefined
        }
      >
        {({ id, describedBy, invalid }) => (
          <Select value={selected} onValueChange={choose} disabled={readOnly}>
            <SelectTrigger
              ref={trigger}
              id={id}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent
              onCloseAutoFocus={(e) => {
                if (!focusCustom.current) return;
                focusCustom.current = false;
                e.preventDefault();
                custom.current?.focus();
              }}
            >
              <SelectItem value={INHERIT}>
                {scope.mode === "agent" ? CONFIG_COPY.inheritAgent : CONFIG_COPY.inheritTemplate}
              </SelectItem>
              <SelectGroup>
                <SelectLabel>{CONFIG_COPY.aliases}</SelectLabel>
                {MODEL_ALIASES.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectGroup>
              <SelectGroup>
                <SelectLabel>{CONFIG_COPY.modelIds}</SelectLabel>
                {MODEL_IDS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectGroup>
              <SelectItem value={CUSTOM}>{CONFIG_COPY.custom}</SelectItem>
            </SelectContent>
          </Select>
        )}
      </FieldShell>
      {showCustom ? (
        <FieldShell
          name="model-custom"
          label="Custom model"
          hideLabel
          help={MODEL_MSG.chars}
          error={note.error}
        >
          {({ id, describedBy, invalid }) => (
            <Input
              ref={custom}
              id={id}
              value={model ?? ""}
              readOnly={readOnly}
              spellCheck={false}
              autoComplete="off"
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              className="font-mono"
              onChange={(e) => {
                fieldErrors.change("model");
                set(e.target.value === "" ? undefined : e.target.value);
              }}
              onBlur={(e) => fieldErrors.blur("model", e)}
            />
          )}
        </FieldShell>
      ) : null}
    </div>
  );
}
