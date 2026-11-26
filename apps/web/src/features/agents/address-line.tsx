import { type FocusEvent, useEffect, useRef, useState } from "react";
import { AgentAvatar } from "@/components/agent-avatar";
import { FormField } from "@/components/form-field";
import { IN_FORM } from "@/components/ui/button";
import { deriveHandle, useTakenNames } from "@/features/agents/derive-handle";

const EMPTY: ReadonlySet<string> = new Set();
const SETTLE_MS = 300;
const HELP =
  "How agents and people tag this agent, like @team-lead. Lowercase letters, numbers and hyphens.";
const EDIT_HELP = `${HELP} Everything already written shows the new handle. The old one is free for anyone.`;

/** The value after it has stopped changing for `ms`, or at once on `flush` (blur). */
function useDeferredSettle(value: string, ms: number): [string, () => void] {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return [settled, () => setSettled(value)];
}

export function AddressLine({
  name,
  handle,
  handleTouched,
  onHandle,
  onBlur,
  error,
  forceOpen,
  onOpened,
  agentRef,
}: {
  name: string;
  handle: string;
  handleTouched: boolean;
  onHandle: (handle: string) => void;
  /** Leaving the handle input, with its event (the form's validate-on-blur). */
  onBlur?: (e: FocusEvent<HTMLInputElement>) => void;
  /** The handle's error; it opens the line, so the note under the input can show it. */
  error?: string;
  forceOpen?: boolean;
  onOpened?: () => void;
  /** Edit mode: the agent being renamed. The handle is its own, nothing derives from the name, and the help says what a rename does. */
  agentRef?: string;
}) {
  const edit = agentRef !== undefined;
  // Until the taken-sets answer, the derivation shows without a suffix (§6.3).
  const taken = useTakenNames(!edit);
  const shown = edit || handleTouched ? handle : deriveHandle(name, taken ?? EMPTY);
  const [open, setOpen] = useState(false);
  const [avatarHandle, settleAvatar] = useDeferredSettle(shown, SETTLE_MS);

  const inputRef = useRef<HTMLInputElement>(null);

  // State-only guard: a force request or an error opens the field (a closed line would hide it).
  if ((forceOpen || error) && !open) setOpen(true);
  // A force request also moves focus, whether the field just opened or already was.
  useEffect(() => {
    if (!forceOpen) return;
    inputRef.current?.focus();
    onOpened?.();
  }, [forceOpen, onOpened]);

  if (open) {
    return (
      <div className="flex items-start gap-2">
        <span className="mt-2.5">
          <AgentAvatar agentRef={agentRef ?? avatarHandle} color={null} size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <FormField
            name="handle"
            label="Handle"
            prefix="@"
            ref={inputRef}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            help={edit ? EDIT_HELP : HELP}
            error={error}
            value={shown}
            onChange={(e) => onHandle(e.target.value)}
            onBlur={(e) => {
              settleAvatar();
              onBlur?.(e);
            }}
          />
        </div>
      </div>
    );
  }
  return (
    <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
      <AgentAvatar agentRef={agentRef ?? avatarHandle} color={null} size={20} />
      <span className="min-w-0">
        {shown ? (
          <>
            Handle{" "}
            <b className="font-mono font-normal text-foreground [overflow-wrap:anywhere]">
              @{shown}
            </b>
          </>
        ) : (
          "Handle: choose one"
        )}
      </span>{" "}
      <span aria-hidden="true">·</span>{" "}
      <button
        type="button"
        className={`shrink-0 whitespace-nowrap underline underline-offset-2 hover:text-foreground ${IN_FORM}`}
        // Opening the address doesn't count as leaving the Display name (DESIGN.md Validation).
        data-skip-validate
        onClick={() => setOpen(true)}
      >
        Change
      </button>
    </p>
  );
}
