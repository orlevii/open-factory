import { Command as CommandPrimitive } from "cmdk";
import { type Ref, type RefObject, useImperativeHandle, useLayoutEffect, useState } from "react";
import { AgentAvatar } from "@/components/agent-avatar";
import { MiddleTruncate } from "@/components/middle-truncate";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import type { CompletionItem } from "./composer";

/** A point in the composer frame's box (its positioned wrapper), at the top of the caret's line. */
export type CaretAnchor = { x: number; y: number };

/** What the composer's key handler drives: focus never leaves the textarea (keyboard-opened). */
export type CaretMenuHandle = {
  move(delta: 1 | -1 | number): void;
  /** Picks the highlighted item; false when there is none. */
  accept(): boolean;
};

const COPY_PROPS = [
  "boxSizing",
  "width",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontVariant",
  "letterSpacing",
  "lineHeight",
  "textTransform",
  "textIndent",
  "tabSize",
  "wordSpacing",
] as const;

/**
 * Where the character at `index` sits in the textarea, relative to the textarea's offset parent, by
 * the mirror-div technique: a hidden copy with the same box and type lays out the text before it and
 * a marker span reports its offset. `y` is the top of that line (the menu opens upward from it),
 * clamped to the textarea's visible box when the line has scrolled out of view.
 */
export function caretAnchor(box: HTMLTextAreaElement, index: number): CaretAnchor {
  const doc = box.ownerDocument;
  const style = doc.defaultView?.getComputedStyle(box);
  const mirror = doc.createElement("div");
  const s = mirror.style;
  if (style) for (const p of COPY_PROPS) s[p] = style[p];
  s.position = "absolute";
  s.visibility = "hidden";
  s.top = "0";
  s.left = "-9999px";
  s.whiteSpace = "pre-wrap";
  s.overflowWrap = "break-word";
  s.overflow = "hidden";
  mirror.textContent = box.value.slice(0, index);
  const marker = doc.createElement("span");
  marker.textContent = box.value.slice(index, index + 1) || ".";
  mirror.appendChild(marker);
  doc.body.appendChild(mirror);
  const top = marker.offsetTop - box.scrollTop;
  const left = marker.offsetLeft;
  mirror.remove();
  return {
    x: box.offsetLeft + Math.min(Math.max(left, 0), box.clientWidth),
    y: box.offsetTop + Math.min(Math.max(top, 0), box.clientHeight),
  };
}

const itemClass =
  "flex min-h-8 pointer-coarse:min-h-9 cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm select-none data-[selected=true]:bg-accent";

const keepFocus = (e: { preventDefault(): void }) => e.preventDefault();

/**
 * The composer's caret menu (U3 §13.4): cmdk in a Radix popover anchored to a zero-size element at the
 * caret, opening upward, at most `min(28rem, 100vw - 2rem)` wide. Keyboard-opened, so it never
 * animates and focus stays in the textarea: the composer's keys call `move`/`accept`, and the textarea
 * carries the combobox wiring (`aria-controls`, `aria-activedescendant` on the highlighted row).
 * Mounted only while open, with `items` already filtered and capped by the composer.
 */
export function CaretMenu({
  anchor,
  items,
  onPick,
  onClose,
  input,
  label,
  ref,
}: {
  anchor: CaretAnchor;
  items: readonly CompletionItem[];
  onPick(item: CompletionItem): void;
  onClose(): void;
  input: RefObject<HTMLTextAreaElement | null>;
  /** The listbox's name. */
  label: string;
  ref?: Ref<CaretMenuHandle>;
}) {
  // A new list (the query changed) highlights its first row again.
  const [shown, setShown] = useState(items);
  const [value, setValue] = useState(items[0]?.id ?? "");
  if (shown !== items) {
    setShown(items);
    setValue(items[0]?.id ?? "");
  }
  const index = Math.max(
    0,
    items.findIndex((i) => i.id === value),
  );
  const current = items[index];
  const activeId = current?.id;

  useImperativeHandle(
    ref,
    () => ({
      move(delta) {
        if (!items.length) return;
        const next = (((index + delta) % items.length) + items.length) % items.length;
        setValue(items[next]?.id ?? "");
      },
      accept() {
        if (!current) return false;
        onPick(current);
        return true;
      },
    }),
    [items, index, current, onPick],
  );

  // The textarea is the combobox: it points at the listbox and its highlighted row (cmdk owns both ids).
  // State, not a ref: the portal mounts the list a commit after this component.
  const [list, setList] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const box = input.current;
    if (!box || !list) return;
    // By our own key, not cmdk's `data-selected`, which its store updates a commit later.
    const row = [...list.querySelectorAll<HTMLElement>("[data-caret-item]")].find(
      (el) => el.dataset.caretItem === activeId,
    );
    box.setAttribute("aria-controls", list.id);
    if (row) box.setAttribute("aria-activedescendant", row.id);
    else box.removeAttribute("aria-activedescendant");
  }, [input, activeId, list]);
  useLayoutEffect(() => {
    const box = input.current;
    return () => {
      box?.removeAttribute("aria-activedescendant");
      box?.removeAttribute("aria-controls");
    };
  }, [input]);

  return (
    <Popover open onOpenChange={(open) => !open && onClose()}>
      <PopoverAnchor
        aria-hidden="true"
        className="pointer-events-none absolute size-0"
        style={{ left: anchor.x, top: anchor.y }}
      />
      <PopoverContent
        data-caret-menu
        data-instant=""
        side="top"
        align="start"
        collisionPadding={8}
        onOpenAutoFocus={keepFocus}
        onCloseAutoFocus={keepFocus}
        // A press in the textarea moves the caret; the composer decides whether the menu stays.
        onInteractOutside={(e) => {
          if (e.target === input.current) e.preventDefault();
        }}
        onMouseDown={keepFocus}
        className="w-max max-w-[min(28rem,calc(100vw-2rem))] min-w-56 gap-0 p-1"
      >
        <CommandPrimitive
          label={label}
          shouldFilter={false}
          loop
          value={value}
          onValueChange={setValue}
        >
          <CommandPrimitive.List ref={setList} label={label} className="scroll-py-1">
            {items.map((item) => (
              <CommandPrimitive.Item
                key={item.id}
                value={item.id}
                data-caret-item={item.id}
                onSelect={() => onPick(item)}
                className={itemClass}
              >
                {item.avatar ? (
                  <AgentAvatar
                    slug={item.avatar.slug}
                    template={item.avatar.template}
                    avatarVersion={item.avatar.avatarVersion}
                    size={16}
                  />
                ) : null}
                <span dir="auto" className="min-w-0 shrink [overflow-wrap:anywhere]">
                  {item.label}
                </span>
                {item.detail ? (
                  <span className="ml-auto flex min-w-0 max-w-[50%] font-mono text-xs text-muted-foreground">
                    <MiddleTruncate text={item.detail} />
                  </span>
                ) : null}
              </CommandPrimitive.Item>
            ))}
          </CommandPrimitive.List>
        </CommandPrimitive>
      </PopoverContent>
    </Popover>
  );
}
