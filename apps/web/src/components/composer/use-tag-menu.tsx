import {
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { type CaretAnchor, type CaretMenuHandle, caretAnchor } from "./caret-menu";
import type { CompletionItem, CompletionSource } from "./composer";
import { useTagField } from "./use-tag-field";

/** At most this many rows in a caret menu (U3 §13.3, §13.4). */
const MAX_ROWS = 8;
const NO_ITEMS: CompletionItem[] = [];
const NO_SOURCES: CompletionSource[] = [];

type Box = HTMLTextAreaElement | HTMLInputElement;
/** An open caret menu: its source, the trigger's index, the text typed after it, where it hangs. */
export type OpenMenu = {
  source: CompletionSource;
  from: number;
  query: string;
  anchor: CaretAnchor;
};

/** Whether `text` still has the menu's token where it was typed. */
function holds(m: OpenMenu, text: string): boolean {
  const hit = m.source.opensAt(text, m.from + 1 + m.query.length);
  return hit?.from === m.from && hit.query === m.query;
}

export type TagMenuOptions = {
  /** The stored text (tags as `<@ref>`) and its setter. */
  value: string;
  setValue(next: string): void;
  /** Every menu source that can open in this field, in precedence order (none: no menus). */
  sources: readonly CompletionSource[];
  /** The source whose picks are tag ranges. Present only for a field that tags. */
  tagSource?: CompletionSource | undefined;
  /** The field's element, owned by the caller: the menu reads its caret and value. */
  box: RefObject<Box | null>;
  /** A pick from a source that doesn't tag: the caller writes the new text and caret. */
  acceptPlain?(
    source: CompletionSource,
    item: CompletionItem,
    el: Box,
    from: number,
    caret: number,
  ): void;
};

/**
 * The one owner of the `@` and `/` caret-menu lifecycle over a tag field (U3 §13.3, §13.4): the tag hook, the menu
 * that opens while typing a token, its rows and note, picking, Esc (which keeps the typed token as text), the
 * paste rule (a paste never opens a menu), undo (its restore leaves the menu shut) and the combobox attributes.
 * The caller renders the element with `attach`, `bind`, `combobox` and `keyDown`, and draws `CaretMenu` for `menu`.
 */
export function useTagMenu({
  value,
  setValue,
  sources,
  tagSource,
  box,
  acceptPlain,
}: TagMenuOptions) {
  // A paste never opens a menu (U3 §13.3): the change it makes is skipped, and so is the text it left
  // until something is typed.
  const pasting = useRef(false);
  const pastedText = useRef<string | undefined>(undefined);
  const [menuState, setMenu] = useState<OpenMenu | undefined>();
  // The trigger whose menu Esc closed: typing on in that token doesn't bring it back.
  const dismissedAt = useRef<number | undefined>(undefined);
  const menuRef = useRef<CaretMenuHandle>(null);
  // A tagging source makes the field a tag field: it shows `@handle` over the stored `<@ref>` text.
  const tag = useTagField({
    value,
    setValue,
    enabled: tagSource !== undefined,
    ...(tagSource?.tagHandle ? { handleOf: tagSource.tagHandle } : {}),
    ...(tagSource?.watchTags ? { subscribe: tagSource.watchTags } : {}),
    // After an undo the caret may sit in an `@query`: its menu stays closed, as after Esc.
    onRestore: (restored, caret) => {
      dismissedAt.current = tagSource?.opensAt(restored, caret)?.from;
      setMenu(undefined);
    },
  });
  const shown = tag.tagged.text;
  // The menu holds only while the text still has its token (a send, Reply or a draft change can
  // replace the text without a keystroke): otherwise it is closed, whatever the state says.
  const menu = menuState && holds(menuState, shown) ? menuState : undefined;
  // Bumped when the open menu's data changes (the users list arriving, a renamed agent).
  const [dataVersion, setDataVersion] = useState(0);
  const watched = menu?.source;
  useEffect(() => watched?.watch?.(() => setDataVersion((v) => v + 1)), [watched]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: dataVersion re-reads the source's data
  const items = useMemo(() => {
    if (!menu) return NO_ITEMS;
    const rows = menu.source.items(menu.query);
    return menu.source.allRows ? rows : rows.slice(0, MAX_ROWS);
  }, [menu, dataVersion]);
  const menuNote = useMemo(() => menu?.source.menuNote?.(items.length), [menu, items]);
  const menuOpen = items.length > 0 || menuNote !== undefined;

  /** Opens, updates or closes the menu for the field's text and caret. */
  const lookForMenu = (el: Box) => {
    if (el.value === pastedText.current) {
      if (menuState) setMenu(undefined);
      return;
    }
    const caret = el.selectionStart === el.selectionEnd ? el.selectionStart : null;
    for (const source of caret === null ? NO_SOURCES : sources) {
      const hit = source.opensAt(el.value, caret as number);
      if (!hit || tag.onTag(hit.from, caret as number)) continue;
      if (dismissedAt.current === hit.from) break;
      dismissedAt.current = undefined;
      if (menu?.source === source && menu.from === hit.from) {
        if (menu.query !== hit.query) setMenu({ ...menu, query: hit.query });
      } else setMenu({ source, ...hit, anchor: caretAnchor(el, hit.from) });
      return;
    }
    if (caret !== null && !sources.some((c) => c.opensAt(el.value, caret))) {
      dismissedAt.current = undefined;
    }
    if (menuState) setMenu(undefined);
  };

  const closeMenu = () => {
    if (menu) dismissedAt.current = menu.from;
    setMenu(undefined);
  };
  /** Drops the menu without marking its token dismissed (a send takes the text with it). */
  const clearMenu = () => setMenu(undefined);

  const pick = (item: CompletionItem) => {
    const el = box.current;
    if (!el || !menu) return;
    const caret = el.selectionStart ?? el.value.length;
    setMenu(undefined);
    if (menu.source.acceptTag) {
      const { ref, handle } = menu.source.acceptTag(item);
      tag.pickTag(menu.from, caret, ref, handle);
    } else acceptPlain?.(menu.source, item, el, menu.from, caret);
    el.focus();
  };

  /** The field's change: tags follow the edit; a paste's change is skipped, and any other change looks for a menu. */
  const change = <E extends Box>(e: ChangeEvent<E>) => {
    tag.change(e);
    if (pasting.current) {
      pasting.current = false;
      pastedText.current = e.target.value;
      if (menuState) setMenu(undefined);
      return;
    }
    pastedText.current = undefined;
    if (sources.length) lookForMenu(e.target);
  };

  const select = <E extends Box>(el: E) => {
    tag.select(el);
    if (sources.length) lookForMenu(el);
  };

  /** Tags in a paste go in as tags, with no change event; anything else is the browser's paste. */
  const paste = <E extends Box>(e: ClipboardEvent<E>) => {
    const left = tag.paste(e);
    pasting.current = left === undefined;
    // Tags went in with no change event: a menu stays shut for the text the paste left.
    if (left !== undefined) pastedText.current = left;
  };

  /**
   * The menu's keys (U3 §13.3), after the tag field's own: arrows move, Enter and Tab pick (Enter sends as typed
   * when the row says so), Esc closes the menu and keeps the token as text. True when the key was used.
   */
  const keyDown = <E extends Box>(e: KeyboardEvent<E>): boolean => {
    // A key before the change: what follows is typed (⌘V's paste comes after).
    pasting.current = false;
    if (tag.keyDown(e)) return true;
    if (!menu || !menuOpen) return false;
    const plain = !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
    if (plain && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      menuRef.current?.move(e.key === "ArrowDown" ? 1 : -1);
      return true;
    }
    // Tab commits too (Q43). Enter takes only a row that says it may; otherwise it sends the text as typed.
    if (plain && (e.key === "Enter" || e.key === "Tab")) {
      if (menuRef.current?.accept(e.key === "Enter")) {
        e.preventDefault();
        return true;
      }
      if (e.key === "Tab") return true;
    }
    // Esc closes the menu first and leaves the text; it never goes on to stop the turn.
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
      return true;
    }
    return false;
  };

  /** The element's ref: it attaches the field to the tag hook and to `box`; the cleanup detaches both. */
  const attach = useCallback(
    (el: Box | null) => {
      box.current = el;
      const detach = tag.ref(el);
      // With a cleanup returned React doesn't call the ref with null: clear it there.
      return () => {
        detach?.();
        box.current = null;
      };
    },
    [tag.ref, box],
  );

  /** The combobox wiring of a field with a menu (the composer's and every tag field's). */
  const combobox = sources.length
    ? {
        role: "combobox" as const,
        "aria-haspopup": "listbox" as const,
        "aria-expanded": menuOpen,
        "aria-autocomplete": "list" as const,
      }
    : {};

  return {
    tag,
    menu,
    menuOpen,
    items,
    menuNote,
    menuRef,
    combobox,
    pick,
    closeMenu,
    clearMenu,
    lookForMenu,
    change,
    select,
    paste,
    keyDown,
    attach,
  };
}
