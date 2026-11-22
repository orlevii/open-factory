import { useEffect, useState } from "react";
import { AgentAvatar } from "@/components/agent-avatar";
import { FormField } from "@/components/form-field";
import { deriveSlug, useTakenNames } from "@/features/agents/derive-slug";

const EMPTY: ReadonlySet<string> = new Set();
const SETTLE_MS = 300;

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
  slug,
  slugTouched,
  onSlug,
  error,
  forceOpen,
  onOpened,
}: {
  name: string;
  slug: string;
  slugTouched: boolean;
  onSlug: (slug: string) => void;
  error?: string;
  forceOpen?: boolean;
  onOpened?: () => void;
}) {
  // Until the taken-sets answer, the derivation shows without a suffix (§6.3).
  const taken = useTakenNames(true);
  const shown = slugTouched ? slug : deriveSlug(name, taken ?? EMPTY);
  const [open, setOpen] = useState(false);
  const [avatarSlug, settleAvatar] = useDeferredSettle(shown, SETTLE_MS);

  // State-only guard: a force request opens the field once, then reports it.
  if (forceOpen && !open) setOpen(true);
  useEffect(() => {
    if (forceOpen) onOpened?.();
  }, [forceOpen, onOpened]);

  if (open) {
    return (
      <div className="flex items-start gap-2">
        <span className="mt-2.5">
          <AgentAvatar slug={avatarSlug} size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <FormField
            name="slug"
            label="Slug"
            prefix="@"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            help="How others address this agent, like @team-lead. Lowercase letters, numbers and hyphens. Can't be changed later."
            error={error}
            value={shown}
            onChange={(e) => onSlug(e.target.value)}
            onBlur={settleAvatar}
          />
        </div>
      </div>
    );
  }
  return (
    <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
      <AgentAvatar slug={avatarSlug} size={20} />
      <span className="min-w-0">
        {shown ? (
          <>
            Address{" "}
            <b className="font-mono font-normal text-foreground [overflow-wrap:anywhere]">
              @{shown}
            </b>
          </>
        ) : (
          "Address: choose one"
        )}
      </span>{" "}
      <span aria-hidden="true">·</span>{" "}
      <button
        type="button"
        className="shrink-0 whitespace-nowrap underline underline-offset-2 hover:text-foreground"
        onClick={() => setOpen(true)}
      >
        Change
      </button>
    </p>
  );
}
