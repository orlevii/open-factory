import { type ComponentProps, type KeyboardEvent, type Ref, useCallback, useRef } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { CaretMenu } from "./caret-menu";
import type { CompletionSource } from "./composer";
import { TagHighlighter } from "./tag-highlighter";
import { useTagMenu } from "./use-tag-menu";

type Box = HTMLTextAreaElement | HTMLInputElement;
const NO_SOURCES: CompletionSource[] = [];

export type TagFieldProps = {
  /** The stored text: tags as `<@ref>`. */
  value: string;
  onValueChange(next: string): void;
  /** The `@` source that tags. Without one the field is plain text. */
  source?: CompletionSource;
};

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

/**
 * A textarea or input that tags: the shared tag menu (use-tag-menu.tsx) over the field, with the highlighter behind it
 * and the menu beside it. The field spreads `bind` and `combobox`, takes `setBox` as its ref, and `keyDown` as its key
 * handler, and renders `decor`.
 */
function useTagInput<E extends Box>({
  value,
  onValueChange,
  source,
  multiline,
  ref,
}: TagFieldProps & { multiline: boolean; ref: Ref<E> | undefined }) {
  const box = useRef<Box | null>(null);
  const m = useTagMenu({
    value,
    setValue: onValueChange,
    sources: source ? [source] : NO_SOURCES,
    tagSource: source,
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
      {m.tag.highlighter ? <TagHighlighter {...m.tag.highlighter} multiline={multiline} /> : null}
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
    shown: m.tag.tagged.text,
    setBox,
    decor,
    keyDown,
    combobox: m.combobox,
    bind: {
      ...m.tag.bind,
      onChange: m.change,
      onSelect: (e: { currentTarget: Box }) => m.select(e.currentTarget),
      onPaste: m.paste,
    },
  };
}

type TextareaProps = Omit<ComponentProps<typeof Textarea>, "value" | "onChange"> & TagFieldProps;

/** A textarea that tags: `@` opens the "Tag someone" menu, tags are atomic and the value is stored as `<@ref>`. */
export function TagTextarea({
  value,
  onValueChange,
  source,
  ref,
  onKeyDown,
  className,
  ...rest
}: TextareaProps & { ref?: Ref<HTMLTextAreaElement> }) {
  const t = useTagInput({ value, onValueChange, source, multiline: true, ref });
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

type InputProps = Omit<ComponentProps<typeof Input>, "value" | "onChange"> & TagFieldProps;

/** A single-line input that tags. Enter keeps its own meaning: it picks a row while a menu is open, else it's the field's. */
export function TagInput({
  value,
  onValueChange,
  source,
  ref,
  onKeyDown,
  className,
  ...rest
}: InputProps & { ref?: Ref<HTMLInputElement> }) {
  const t = useTagInput({ value, onValueChange, source, multiline: false, ref });
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
