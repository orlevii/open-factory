import {
  type ChangeEvent,
  type ClipboardEvent,
  type ComponentProps,
  type KeyboardEvent,
  type Ref,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { type CaretAnchor, CaretMenu, type CaretMenuHandle, caretAnchor } from "./caret-menu";
import type { CompletionItem, CompletionSource } from "./composer";
import { TagHighlighter } from "./tag-highlighter";
import { useTagField } from "./use-tag-field";

/** The rows an `@` menu shows: the best eight, unless the source asks for all of them (as the composer does). */
const MAX_ROWS = 8;
const NO_ITEMS: readonly CompletionItem[] = [];

type Box = HTMLTextAreaElement | HTMLInputElement;
type Open = { from: number; query: string; anchor: CaretAnchor };

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
 * The tag hook and its `@` menu for one textarea or input, wired the way the composer wires them: the hook owns the
 * ranges, the menu opens while typing an `@` token and picks through `acceptTag`, and Esc closes the menu only.
 * The field spreads `bind`, takes `keyDown` as its key handler, renders `setBox` as its ref and `decor` beside it.
 */
function useTagInput<E extends Box>({
  value,
  onValueChange,
  source,
  multiline,
  ref,
}: TagFieldProps & { multiline: boolean; ref: Ref<E> | undefined }) {
  const box = useRef<Box | null>(null);
  // The `@` whose menu Esc closed: typing on in that token doesn't bring it back.
  const dismissed = useRef<number | undefined>(undefined);
  // A paste never opens a menu: the change it makes is skipped, and so is the text it left.
  const pasting = useRef(false);
  const pastedText = useRef<string | undefined>(undefined);
  const menuRef = useRef<CaretMenuHandle>(null);
  const [open, setOpen] = useState<Open | undefined>(undefined);
  const [dataVersion, bumpData] = useReducer((n: number) => n + 1, 0);

  const tag = useTagField({
    value,
    setValue: onValueChange,
    enabled: source !== undefined,
    ...(source?.tagHandle ? { handleOf: source.tagHandle } : {}),
    ...(source?.watchTags ? { subscribe: source.watchTags } : {}),
    // After an undo the caret may sit in an `@query`: its menu stays closed, as after Esc.
    onRestore: (restored, caret) => {
      dismissed.current = source?.opensAt(restored, caret)?.from;
      setOpen(undefined);
    },
  });

  const shown = tag.tagged.text;
  // The menu holds only while its `@` is still in the text: a draft or a send can replace the text unasked.
  const menu = open && source && shown[open.from] === "@" ? open : undefined;
  const watching = menu ? source : undefined;
  useEffect(() => watching?.watch?.(() => bumpData()), [watching]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: dataVersion re-reads the source's rows
  const items = useMemo(() => {
    if (!menu || !source) return NO_ITEMS;
    const rows = source.items(menu.query);
    return source.allRows ? rows : rows.slice(0, MAX_ROWS);
  }, [menu, source, dataVersion]);
  const note = menu ? source?.menuNote?.(items.length) : undefined;
  const menuOpen = menu !== undefined && (items.length > 0 || note !== undefined);

  const closeMenu = () => {
    if (menu) dismissed.current = menu.from;
    setOpen(undefined);
  };

  /** Opens, moves or closes the menu for the field's text and caret. */
  const lookForMenu = (el: Box) => {
    const caret = el.selectionStart === el.selectionEnd ? el.selectionStart : null;
    if (!source || caret === null) {
      setOpen(undefined);
      return;
    }
    if (el.value === pastedText.current) {
      setOpen(undefined);
      return;
    }
    const hit = source.opensAt(el.value, caret);
    if (!hit) {
      dismissed.current = undefined;
      setOpen(undefined);
      return;
    }
    if (tag.onTag(hit.from, caret) || dismissed.current === hit.from) {
      setOpen(undefined);
      return;
    }
    dismissed.current = undefined;
    const anchor = caretAnchor(el, hit.from);
    setOpen((prev) =>
      prev && prev.from === hit.from && prev.query === hit.query
        ? prev
        : { from: hit.from, query: hit.query, anchor },
    );
  };

  const change = <E extends Box>(e: ChangeEvent<E>) => {
    tag.change(e);
    if (pasting.current) {
      pasting.current = false;
      pastedText.current = e.target.value;
      setOpen(undefined);
      return;
    }
    pastedText.current = undefined;
    lookForMenu(e.target);
  };

  const select = <E extends Box>(el: E) => {
    tag.select(el);
    lookForMenu(el);
  };

  const paste = <E extends Box>(e: ClipboardEvent<E>) => {
    const left = tag.paste(e);
    pasting.current = left === undefined;
    if (left !== undefined) pastedText.current = left;
  };

  const pick = (item: CompletionItem) => {
    const el = box.current;
    if (!el || !menu || !source?.acceptTag) return;
    const caret = el.selectionStart ?? el.value.length;
    const { ref: tagRef, handle } = source.acceptTag(item);
    setOpen(undefined);
    tag.pickTag(menu.from, caret, tagRef, handle);
    el.focus();
  };

  /** The menu's keys first (U3 §13.3): arrows move, Enter and Tab pick, Esc closes the menu and keeps the text. */
  const keyDown = <E extends Box>(e: KeyboardEvent<E>, passed?: (e: KeyboardEvent<E>) => void) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) {
      passed?.(e);
      return;
    }
    pasting.current = false;
    if (tag.keyDown(e)) return;
    if (menu && menuOpen) {
      const plain = !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
      if (plain && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        menuRef.current?.move(e.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (plain && (e.key === "Enter" || e.key === "Tab")) {
        if (menuRef.current?.accept(e.key === "Enter")) {
          e.preventDefault();
          return;
        }
        if (e.key === "Tab") return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeMenu();
        return;
      }
    }
    passed?.(e);
  };

  const setBox = useCallback(
    (el: E | null) => {
      box.current = el;
      const detach = tag.ref(el);
      assignRef(ref, el);
      // With a cleanup returned React doesn't call the ref with null: clear it there.
      return () => {
        detach?.();
        box.current = null;
        assignRef(ref, null);
      };
    },
    [tag.ref, ref],
  );

  const decor = (
    <>
      {tag.highlighter ? <TagHighlighter {...tag.highlighter} multiline={multiline} /> : null}
      {menuOpen && menu && source ? (
        <CaretMenu
          ref={menuRef}
          input={box}
          label={source.label ?? ""}
          anchor={menu.anchor}
          items={items}
          note={note}
          onPick={pick}
          onClose={closeMenu}
        />
      ) : null}
    </>
  );

  return {
    shown,
    setBox,
    decor,
    keyDown,
    bind: {
      ...tag.bind,
      onChange: change,
      onSelect: (e: { currentTarget: Box }) => select(e.currentTarget),
      onPaste: paste,
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
        ref={t.setBox}
        value={t.shown}
        {...t.bind}
        onKeyDown={(e) => t.keyDown(e, onKeyDown)}
        className={cn("bg-transparent dark:bg-transparent", className)}
      />
    </div>
  );
}
