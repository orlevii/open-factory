import { type ComponentProps, type KeyboardEvent, type Ref, useCallback, useRef } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { CaretMenu } from "./caret-menu";
import type { CompletionSource } from "./composer";
import { MentionHighlighter } from "./mention-highlighter";
import { useMentionMenu } from "./use-mention-menu";

type Box = HTMLTextAreaElement | HTMLInputElement;
const NO_SOURCES: CompletionSource[] = [];

export type MentionFieldProps = {
  /** The stored text: mentions as `<@ref>`. */
  value: string;
  onValueChange(next: string): void;
  /** The `@` source that mentions. Without one the field is plain text. */
  source?: CompletionSource;
};

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

/**
 * A textarea or input that mentions: the shared mention menu (use-mention-menu.tsx) over the field, with the highlighter behind it
 * and the menu beside it. The field spreads `bind` and `combobox`, takes `setBox` as its ref, and `keyDown` as its key
 * handler, and renders `decor`.
 */
function useMentionInput<E extends Box>({
  value,
  onValueChange,
  source,
  multiline,
  ref,
}: MentionFieldProps & { multiline: boolean; ref: Ref<E> | undefined }) {
  const box = useRef<Box | null>(null);
  const m = useMentionMenu({
    value,
    setValue: onValueChange,
    sources: source ? [source] : NO_SOURCES,
    mentionSource: source,
    box,
  });
  const { attach } = m;
  const setBox = useCallback(
    (el: E | null) => {
      const detach = attach(el);
      assignRef(ref, el);
      return () => {
        detach();
        assignRef(ref, null);
      };
    },
    [attach, ref],
  );

  /** The field's key handler: IME keys are the browser's; otherwise the menu's keys, then the caller's. */
  const keyDown = (e: KeyboardEvent<E>, passed?: (e: KeyboardEvent<E>) => void) => {
    if (!e.nativeEvent.isComposing && e.keyCode !== 229 && m.keyDown(e)) return;
    passed?.(e);
  };

  const decor = (
    <>
      {m.mention.highlighter ? (
        <MentionHighlighter {...m.mention.highlighter} multiline={multiline} />
      ) : null}
      {m.menu && m.menuOpen && source ? (
        <CaretMenu
          ref={m.menuRef}
          input={box}
          label={source.label ?? ""}
          anchor={m.menu.anchor}
          items={m.items}
          note={m.menuNote}
          onPick={m.pick}
          onClose={m.closeMenu}
        />
      ) : null}
    </>
  );

  return {
    shown: m.mention.mentioned.text,
    setBox,
    decor,
    keyDown,
    combobox: m.combobox,
    bind: {
      ...m.mention.bind,
      onChange: m.change,
      onSelect: (e: { currentTarget: Box }) => m.select(e.currentTarget),
      onPaste: m.paste,
    },
  };
}

type TextareaProps = Omit<ComponentProps<typeof Textarea>, "value" | "onChange"> &
  MentionFieldProps;

/** A textarea that mentions: `@` opens the "Mention someone" menu, mentions are atomic and the value is stored as `<@ref>`. */
export function MentionTextarea({
  value,
  onValueChange,
  source,
  ref,
  onKeyDown,
  className,
  ...rest
}: TextareaProps & { ref?: Ref<HTMLTextAreaElement> }) {
  const t = useMentionInput({ value, onValueChange, source, multiline: true, ref });
  return (
    <div className="relative isolate min-w-0 rounded-lg bg-card">
      {t.decor}
      <Textarea
        {...rest}
        {...t.combobox}
        ref={t.setBox}
        value={t.shown}
        {...t.bind}
        onKeyDown={(e) => t.keyDown(e, onKeyDown)}
        className={cn("bg-transparent dark:bg-transparent", className)}
      />
    </div>
  );
}

type InputProps = Omit<ComponentProps<typeof Input>, "value" | "onChange"> & MentionFieldProps;

/** A single-line input that mentions. Enter keeps its own meaning: it picks a row while a menu is open, else it's the field's. */
export function MentionInput({
  value,
  onValueChange,
  source,
  ref,
  onKeyDown,
  className,
  ...rest
}: InputProps & { ref?: Ref<HTMLInputElement> }) {
  const t = useMentionInput({ value, onValueChange, source, multiline: false, ref });
  return (
    <div className="relative isolate min-w-0 rounded-lg bg-card">
      {t.decor}
      <Input
        {...rest}
        {...t.combobox}
        ref={t.setBox}
        value={t.shown}
        {...t.bind}
        onKeyDown={(e) => t.keyDown(e, onKeyDown)}
        className={cn("bg-transparent dark:bg-transparent", className)}
      />
    </div>
  );
}
