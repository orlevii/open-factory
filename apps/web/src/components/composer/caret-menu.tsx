import { Command as CommandPrimitive } from "cmdk";
import {
  type CSSProperties,
  type Ref,
  type RefObject,
  useImperativeHandle,
  useLayoutEffect,
  useState,
} from "react";
import { AgentAvatar } from "@/components/agent-avatar";
import { MiddleTruncate } from "@/components/middle-truncate";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import type { CompletionItem } from "./composer";

/** A point in the composer frame's box (its positioned wrapper), at the top of the caret's line. */
export type CaretAnchor = { x: number; y: number };

/** What the composer's key handler drives: focus never leaves the textarea (keyboard-opened). */
export type CaretMenuHandle = {
  move(delta: 1 | -1 | number): void;
  /** Picks the highlighted item; false when there is none, it is disabled, or (for Enter) it sends the
   *  text as typed instead. */
  accept(enter?: boolean): boolean;
};

const COPY_PROPS = [
  "boxSizing",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "borderStyle",
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
  "wordBreak",
  "direction",
  "textAlign",
  "unicodeBidi",
] as const;

const clamp = (n: number, max: number) => Math.min(Math.max(n, 0), max);

/**
 * Where the character at `index` sits in the textarea, relative to the textarea's offset parent, by
 * the mirror-div technique: a hidden copy with the same box, type and direction lays out the text
 * before it and a marker span reports its offset. The copy is narrower by the textarea's scrollbar
 * gutter, so it wraps where the textarea does. `y` is the top of that line (the menu opens upward
 * from it); both are clamped to the textarea's visible content box when the line has scrolled out of
 * view.
 */
export function caretAnchor(box: HTMLTextAreaElement, index: number): CaretAnchor {
  const doc = box.ownerDocument;
  const mirror = doc.createElement("div");
  try {
    const style = doc.defaultView?.getComputedStyle(box);
    const s = mirror.style;
    if (style) {
      for (const p of COPY_PROPS) s[p] = style[p];
      const gutter = Math.max(0, box.offsetWidth - box.clientWidth - 2 * box.clientLeft);
      const width = Number.parseFloat(style.width);
      if (Number.isFinite(width)) s.width = `${Math.max(0, width - gutter)}px`;
    }
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
    // Offsets inside the copy are from its padding edge; the textarea's border comes on top.
    return {
      x: box.offsetLeft + box.clientLeft + clamp(marker.offsetLeft, box.clientWidth),
      y: box.offsetTop + box.clientTop + clamp(marker.offsetTop - box.scrollTop, box.clientHeight),
    };
  } finally {
    mirror.remove();
  }
}

/** The rows in runs: a row with a heading starts a group; rows before any heading stand alone. */
function runs(items: readonly CompletionItem[]): { heading?: string; items: CompletionItem[] }[] {
  const out: { heading?: string; items: CompletionItem[] }[] = [];
  for (const it of items) {
    const last = out.at(-1);
    if (it.heading !== undefined || !last) out.push({ heading: it.heading, items: [it] });
    else last.items.push(it);
  }
  return out;
}

/** About 8 rows of each kind: a `/` row is two lines (3rem), an `@` row one (2rem). */
const COMMAND_ROWS_HEIGHT = "24rem";
const MENTION_ROWS_HEIGHT = "16rem";

const itemClass =
  "flex min-h-8 pointer-coarse:min-h-9 cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm select-none data-[selected=true]:bg-accent data-[disabled=true]:text-muted-foreground";

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
  note,
  onPick,
  onClose,
  input,
  label,
  ref,
}: {
  anchor: CaretAnchor;
  items: readonly CompletionItem[];
  /** A muted line under the rows, or alone (an empty state). */
  note?: string | undefined;
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
      accept(enter = false) {
        if (!current || current.disabled || (enter && current.enterSends)) return false;
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
    // The highlight is ours, not cmdk's, so cmdk never scrolls it into view: keep it inside the list's
    // box ("nearest"), scrolling the list only, never the page (re-verification N1b).
    if (row) {
      const r = row.getBoundingClientRect();
      const l = list.getBoundingClientRect();
      if (r.top < l.top) list.scrollTop -= l.top - r.top;
      else if (r.bottom > l.bottom) list.scrollTop += r.bottom - l.bottom;
    }
  }, [input, activeId, list]);
  useLayoutEffect(() => {
    const box = input.current;
    return () => {
      box?.removeAttribute("aria-activedescendant");
      box?.removeAttribute("aria-controls");
    };
  }, [input]);

  const row = (item: CompletionItem) => (
    <CommandPrimitive.Item
      key={item.id}
      value={item.id}
      data-caret-item={item.id}
      disabled={item.disabled !== undefined}
      onSelect={() => onPick(item)}
      className={itemClass}
    >
      {item.kind === "command" ? <CommandRow item={item} /> : <MentionRow item={item} />}
    </CommandPrimitive.Item>
  );
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
        // Capped at the room Radix measures above the caret, the list scrolling inside (at 200% text
        // the menu would otherwise run past the top of the viewport; evidence D6).
        // Never wider than the viewport, 200% text on a phone included (re-verification N4).
        className="flex max-h-(--radix-popover-content-available-height) w-max max-w-[min(28rem,calc(100vw-2rem))] min-w-[min(14rem,calc(100vw-2rem))] flex-col gap-0 p-1"
      >
        <CommandPrimitive
          label={label}
          className="flex min-h-0 flex-col"
          shouldFilter={false}
          loop
          value={value}
          onValueChange={setValue}
        >
          <CommandPrimitive.List
            ref={setList}
            label={label}
            // The list scrolls itself, at about 8 rows' height and within the room above the caret (less
            // the popover's padding and a note), so the highlighted row is always scrolled into view
            // (re-verification N1, N2).
            className={`min-h-0 scroll-py-1 overflow-y-auto ${note ? "max-h-[min(var(--caret-menu-rows-height),calc(var(--radix-popover-content-available-height)-3rem))]" : "max-h-[min(var(--caret-menu-rows-height),calc(var(--radix-popover-content-available-height)-0.5rem))]"}`}
            style={
              {
                "--caret-menu-rows-height": items.some((i) => i.kind === "command")
                  ? COMMAND_ROWS_HEIGHT
                  : MENTION_ROWS_HEIGHT,
              } as CSSProperties
            }
          >
            {runs(items).map((run) =>
              run.heading ? (
                <CommandPrimitive.Group
                  key={`g:${run.items[0]?.id}`}
                  heading={run.heading}
                  className="**:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:pt-1.5 **:[[cmdk-group-heading]]:pb-0.5 **:[[cmdk-group-heading]]:text-xs **:[[cmdk-group-heading]]:text-muted-foreground"
                >
                  {run.items.map(row)}
                </CommandPrimitive.Group>
              ) : (
                run.items.map(row)
              ),
            )}
          </CommandPrimitive.List>
          {note ? (
            <p className="px-2 py-1.5 text-[0.8125rem] leading-[1.125rem] text-muted-foreground">
              {note}
            </p>
          ) : null}
        </CommandPrimitive>
      </PopoverContent>
    </Popover>
  );
}

/**
 * A `/` row (U3 §13.3): `/name` in mono, middle-truncated keeping the part after a plugin's `:` (the
 * prefix muted); the argument hint muted, hidden below a 24rem menu (a viewport under 26rem: the menu
 * is at most 100vw - 2rem wide; a container query would collapse the content-sized menu, review I1); "alias: cost" when an alias
 * matched; a one-line description under it.
 */
function CommandRow({ item }: { item: CompletionItem }) {
  const name = item.label;
  const colon = name.lastIndexOf(":");
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="flex min-w-0 items-baseline gap-2">
        {/* The name never yields to the hint (evidence D8). A plugin name keeps its `/` and a few
            characters of its prefix, then the part after `:` (D10). */}
        {colon > 0 ? (
          <span data-command-name className="flex max-w-full shrink-0 font-mono text-[0.8125rem]">
            <span
              aria-hidden="true"
              data-command-prefix
              className="min-w-[4ch] truncate text-muted-foreground"
            >
              {name.slice(0, colon + 1)}
            </span>
            <span aria-hidden="true" className="max-w-[calc(100%-4ch)] shrink-0 truncate">
              {name.slice(colon + 1)}
            </span>
            <span className="sr-only">{name}</span>
          </span>
        ) : (
          <span
            data-command-name
            className="max-w-full shrink-0 truncate font-mono text-[0.8125rem]"
          >
            {name}
          </span>
        )}
        {item.hint ? (
          <span
            data-arg-hint
            className="min-w-0 truncate font-mono text-xs text-muted-foreground max-[26rem]:hidden"
          >
            {item.hint}
          </span>
        ) : null}
        {item.alias ? (
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">{item.alias}</span>
        ) : null}
      </span>
      {item.detail ? (
        <span className="truncate text-xs text-muted-foreground">{item.detail}</span>
      ) : null}
    </span>
  );
}

/** An `@` row (U3 §13.4): the avatar, the name (wrapping) and the muted, middle-truncated handle. */
function MentionRow({ item }: { item: CompletionItem }) {
  return (
    <>
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
    </>
  );
}
