import { type ComponentProps, type KeyboardEvent, type Ref, useId, useRef, useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type Props = Omit<
  ComponentProps<"textarea">,
  "value" | "onChange" | "onBlur" | "id" | "aria-describedby"
> & {
  value: string;
  onChange(v: string): void;
  onBlur?(): void;
  onSave?(): void;
  id: string;
  /** Ids of the field's other descriptions; the keyboard hint is appended. */
  describedBy?: string;
  textareaRef?: Ref<HTMLTextAreaElement>;
};

/** One mono textarea unit for files edited as raw text. Tab inserts two spaces (through
 *  setRangeText, so undo keeps working); Escape arms a one-shot flag so the next Tab leaves
 *  the field (WCAG 2.1.2); Cmd/Ctrl+S saves. */
export function CodeTextarea({
  value,
  onChange,
  onBlur,
  onSave,
  id,
  describedBy,
  textareaRef,
  className,
  ...rest
}: Props) {
  const escArmed = useRef(false);
  const [focused, setFocused] = useState(false);
  const hintId = `${useId()}-hint`;

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      onSave?.();
      return;
    }
    if (e.key === "Escape") {
      escArmed.current = true;
      return;
    }
    if (e.key === "Tab" && !e.shiftKey && !escArmed.current) {
      e.preventDefault();
      const t = e.currentTarget;
      t.setRangeText("  ", t.selectionStart, t.selectionEnd, "end");
      onChange(t.value);
      return;
    }
    if (e.key !== "Shift" && e.key !== "Tab") escArmed.current = false;
  }

  return (
    <div className="grid gap-1.5">
      <div className="overflow-hidden rounded-lg border border-input bg-card transition-[box-shadow,border-color] duration-150 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/20">
        <Textarea
          {...rest}
          id={id}
          ref={textareaRef}
          value={value}
          spellCheck={false}
          aria-describedby={[describedBy, hintId].filter(Boolean).join(" ")}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            escArmed.current = false;
            setFocused(false);
            onBlur?.();
          }}
          className={cn(
            "field-sizing-fixed min-h-80 resize-y rounded-none border-0 bg-transparent p-3 font-mono text-[0.8125rem] leading-5 shadow-none focus-visible:ring-0 focus-visible:outline-none md:text-[0.8125rem] dark:bg-transparent",
            className,
          )}
        />
      </div>
      {/* Always in the DOM so aria-describedby resolves; shown while the field has focus.
          Touch has no Tab key, so it stays hidden there. */}
      <p
        id={hintId}
        className={cn(
          "text-xs text-muted-foreground [@media(pointer:coarse)]:hidden",
          !focused && "sr-only",
        )}
      >
        Esc then Tab to leave the editor
      </p>
    </div>
  );
}
