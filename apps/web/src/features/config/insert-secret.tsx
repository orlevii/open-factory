import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { secretsQueryOptions } from "@/features/settings/api";
import { openSheetForResult } from "@/features/sheets/sheet-store";
import { CONFIG_COPY } from "./messages";

/** Where a value's caret was when it was left: saved on blur (which also covers touch), in a ref, never in state. */
export type Caret = { start: number; end: number };

/**
 * `${NAME}` into `value` at the saved caret (else at the end), and where the caret goes after it. A caret saved before
 * a later edit shortened the value is clamped.
 */
export function insertReference(
  value: string,
  name: string,
  caret: Caret | null,
): { value: string; at: number } {
  const token = `\${${name}}`;
  const start = Math.min(caret?.start ?? value.length, value.length);
  const end = Math.max(start, Math.min(caret?.end ?? value.length, value.length));
  return { value: value.slice(0, start) + token + value.slice(end), at: start + token.length };
}

/**
 * "Insert secret" (spec §12.2), the ghost action in a value's label row. It opens a popover from its trigger with the
 * factory's secrets and "Add secret", which opens the Add secret sheet and inserts the new name on return. The caller
 * inserts (`onPick`) and moves focus back into its value, so the popover doesn't return focus to this trigger then.
 */
export function InsertSecret({
  label,
  onPick,
}: {
  /** "Insert secret into header value 2": rows repeat, so each trigger names its value. */
  label: string;
  /** A picked name. `fromSheet`: it came back from Add secret, whose close returns focus itself. */
  onPick: (name: string, fromSheet: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const picked = useRef(false);
  const pick = (name: string) => {
    picked.current = true;
    setOpen(false);
    onPick(name, false);
  };
  const addSecret = () => {
    picked.current = true;
    setOpen(false);
    openSheetForResult({ kind: "add-secret", name: "" }, (name) => onPick(name, true));
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="xs" aria-label={label}>
          {CONFIG_COPY.insertSecret}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label={CONFIG_COPY.insertSecret}
        className="w-[min(18rem,calc(100vw-2rem))] gap-1 p-1"
        onCloseAutoFocus={(e) => {
          // A pick moves focus into the value (or the sheet takes it): don't pull it back to the trigger.
          if (picked.current) e.preventDefault();
          picked.current = false;
        }}
      >
        <SecretChoices onPick={pick} />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="justify-start"
          onClick={addSecret}
        >
          <Plus aria-hidden="true" />
          {CONFIG_COPY.addSecret}
        </Button>
      </PopoverContent>
    </Popover>
  );
}

/** Mounted only while the popover is open: the secrets list is fetched on the first look, through the shared query. */
function SecretChoices({ onPick }: { onPick: (name: string) => void }) {
  const q = useQuery(secretsQueryOptions);
  if (q.isPending) return <p className="px-2 py-1.5 text-sm text-muted-foreground">Loading…</p>;
  if (q.isError)
    return <p className="px-2 py-1.5 text-sm text-muted-foreground">Couldn't load secrets.</p>;
  if (q.data.length === 0)
    return <p className="px-2 py-1.5 text-sm text-muted-foreground">No secrets yet.</p>;
  return (
    <ul aria-label="Secrets" className="grid max-h-60 overflow-y-auto overscroll-contain">
      {q.data.map((s) => (
        <li key={s.name}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full justify-start font-mono text-[0.8125rem]"
            onClick={() => onPick(s.name)}
          >
            {s.name}
          </Button>
        </li>
      ))}
    </ul>
  );
}
