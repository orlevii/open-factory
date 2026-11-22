import { type InfiniteData, useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Ellipsis } from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type Ref,
  type RefObject,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { CopyFailed, CopyIcon, useCopy } from "@/components/copy-feedback";
import {
  AdaptiveMenu,
  AdaptiveMenuContent,
  AdaptiveMenuItem,
  AdaptiveMenuLabel,
  AdaptiveMenuTrigger,
} from "@/components/ui/adaptive-menu";
import { Button } from "@/components/ui/button";
import { inboxQueryOptions } from "@/features/inbox/api";
import { useMedia } from "@/lib/breakpoints";
import { formatTime } from "./format";
import { parseSendResult } from "./outgoing-message";
import type { Row } from "./rows";

/** One row-menu entry (U3 §7.5). Plain data, so a row's list is memoized per row object. */
export type RowMenuItem =
  | { kind: "copy"; label: string; text: string }
  /** Shows or hides the raw call (outgoing, spawn). */
  | { kind: "call"; label: string }
  /** Your inbox item for this send (to a human), by the message's id: shown only once found. */
  | { kind: "inbox"; label: string; messageId: string }
  /** The message in the recipient agent's session. */
  | { kind: "session"; label: string; to: string; messageId: string }
  /** The row's time, as a label: touch only, where the gutter time never shows. */
  | { kind: "time"; label: string };

const pad = (n: number) => String(n).padStart(2, "0");
const clock = (iso: string) => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

/** The items that apply to `row`, and only those: Copy link (all), Copy text (agent text, message
 *  bodies: the markdown source), Copy command (Bash), View tool call (outgoing, spawn), View in the
 *  recipient's session (a delivered send to an agent), Open in inbox (a send to a human, when it is
 *  in your inbox), and the time on touch. */
export function rowMenuItems(row: Row, slug: string): RowMenuItem[] {
  const items: RowMenuItem[] = [
    {
      kind: "copy",
      label: "Copy link",
      text: `${location.origin}/agents/${encodeURIComponent(slug)}?event=${row.seq}`,
    },
  ];
  if (row.kind === "text") items.push({ kind: "copy", label: "Copy text", text: row.text });
  if (row.kind === "message")
    items.push({ kind: "copy", label: "Copy text", text: row.message.body });
  if (row.kind === "peer")
    items.push({ kind: "copy", label: "Copy text", text: row.envelope.body });
  if (row.kind === "command") items.push({ kind: "copy", label: "Copy command", text: row.text });
  if (row.kind === "command_output")
    items.push({ kind: "copy", label: "Copy text", text: row.text });
  if (row.kind === "tool" && row.call.name === "Bash") {
    const command = (row.call.input as { command?: unknown } | undefined)?.command;
    if (typeof command === "string")
      items.push({ kind: "copy", label: "Copy command", text: command });
  }
  if (row.kind === "outgoing") {
    const body = (row.call.input as { body?: unknown }).body;
    if (typeof body === "string") items.push({ kind: "copy", label: "Copy text", text: body });
  }
  if (row.kind === "outgoing" || row.kind === "spawn")
    items.push({ kind: "call", label: "View tool call" });
  // A human's copy lands in the inbox; an agent's in its session. A result names agents bare.
  const sent = row.kind === "outgoing" ? parseSendResult(row.result) : undefined;
  if (sent?.to.startsWith("@"))
    items.push({ kind: "inbox", label: "Open in inbox", messageId: sent.id });
  else if (sent)
    items.push({
      kind: "session",
      label: `View in @${sent.to}'s session`,
      to: sent.to,
      messageId: sent.id,
    });
  if ("at" in row && row.at) {
    const speech =
      row.kind === "message" ||
      row.kind === "outgoing" ||
      row.kind === "text" ||
      row.kind === "command";
    items.push({ kind: "time", label: speech ? `Sent ${clock(row.at)}` : clock(row.at) });
  }
  return items;
}

const at = (name: string, iso: string | undefined) => (iso ? `${name} · ${formatTime(iso)}` : name);
const handle = (who: string) => (who.startsWith("@") ? who : `@${who}`);

/** The row's name on the phone drawer's title line (U4 §11.1): "Message from @or · 17:55",
 *  "Bash · 17:55", the agent for its own text. */
export function rowMenuTitle(row: Row, slug: string): string {
  switch (row.kind) {
    case "message":
      return at(`Message from ${handle(row.message.from)}`, row.at);
    case "peer":
      return `Message from ${handle(row.envelope.from)}`;
    case "update_group":
      return at(`Updates about ${row.about}`, row.at);
    case "outgoing": {
      const to = (row.call.input as { to?: unknown }).to;
      return at(typeof to === "string" ? `Message to ${handle(to)}` : "Message", row.at);
    }
    case "spawn":
      return at("Spawn", row.at);
    case "terminate":
      return at("Terminate", row.at);
    case "tool":
      return at(row.call.name, row.at);
    case "text":
      return at(handle(slug), row.at);
    case "command":
      return at("Command", row.at);
    case "command_output":
      return at(row.command, row.at);
    case "turn_footer":
      return "Turn summary";
    default:
      return at(OTHER[row.kind] ?? "Event", "at" in row ? row.at : undefined);
  }
}
const OTHER: Partial<Record<Row["kind"], string>> = {
  subagent: "Subagent",
  work_group: "Tool calls",
  error: "Error",
  compaction: "Compaction",
  denied: "Permission denied",
  orphan_result: "Tool result",
};

/** Where the trigger sits (U3 §7.5): in an unboxed row's 2rem right column, or inside a card's own
 *  right padding (`pr-9`), off its border. "Couldn't copy" sits just left of it. */
const PLACE = {
  gutter: { trigger: "top-1 right-0", failed: "top-1 right-8" },
  card: { trigger: "top-1.5 right-1.5", failed: "top-1.5 right-9" },
} as const;

// On coarse pointers the trigger is a visible 32×40 box filling its gutter (U4 §11.3), with no expander over the
// row's text.
const COARSE = "pointer-coarse:h-10 pointer-coarse:w-8 after:hidden";
// Shown instantly on hover or focus within the row (fine pointers), always on touch, and always while
// its menu is open: the modal menu takes the row's hover and focus, and Radix anchors the menu to
// this element's box, so a hidden trigger would send it to the viewport's corner. The 0.98 press is
// explicit: Button leaves it off popup triggers.
const TRIGGER =
  "absolute text-muted-foreground group-focus-within:inline-flex group-hover:inline-flex pointer-coarse:inline-flex data-[state=open]:inline-flex data-returning:inline-flex active:scale-[0.98] motion-reduce:active:scale-100";
/** A nested row's (a folded run's call): its own `group/call` box decides, never the item's. */
const TRIGGER_NESTED =
  "absolute text-muted-foreground group-focus-within/call:inline-flex group-hover/call:inline-flex pointer-coarse:inline-flex data-[state=open]:inline-flex data-returning:inline-flex active:scale-[0.98] motion-reduce:active:scale-100";

type Point = { x: number; y: number };
/** Opens a row's menu from outside it (a long-press on the row), without lifting its state. */
export type RowMenuHandle = { openAt(p: Point): void };
type MenuState = { mounted: boolean; open: boolean; anchor?: Point };
const AT_REST: MenuState = { mounted: false, open: false };

/**
 * The one ⋯ per row (U3 §7.5). At rest it is a plain button, so a long timeline mounts no menu roots
 * and reads no media query; the first intent mounts the menu already open, and it stays mounted: a
 * mouse pointer down, Enter or Space, a touch or pen tap's click (never its pointer down, so starting
 * a scroll on ⋯ opens nothing, U4 §11.1), or `openAt` through the ref. On a phone it is a drawer.
 * It keeps `data-copy-link` (the roving tabindex leaves it alone) and its own `tabIndex`. A copy turns
 * the icon into a check for 1.5s; "Couldn't copy" shows inline.
 */
export function RowMenu({
  ref,
  items,
  title,
  focusable,
  label = "Row actions",
  callShown = false,
  onToggleCall,
  nested = false,
  inCard = false,
}: {
  ref?: Ref<RowMenuHandle>;
  /** The list, or a stable function that builds it: called only once the menu is first opened, so a
   *  long timeline does none of that work at mount. */
  items: readonly RowMenuItem[] | (() => readonly RowMenuItem[]);
  /** Names the row on the phone drawer; a function is called only once the menu is mounted. */
  title: string | (() => string);
  /** The row is the timeline's tab stop. */
  focusable: boolean;
  label?: string;
  /** The raw call is showing: its item reads "Hide tool call". */
  callShown?: boolean;
  onToggleCall?(): void;
  /** Inside another row (`NestedRow`): shown on its own box's hover and focus. */
  nested?: boolean;
  /** The row is a card: the trigger sits inside its padding. */
  inCard?: boolean;
}) {
  const { state, instant, copy } = useCopy();
  const place = PLACE[inCard ? "card" : "gutter"];
  const [menu, setMenu] = useState<MenuState>(AT_REST);
  // The first opening mounts the menu after the key that asked for it, so Radix's own
  // keyboard-modality listener never saw that key: the content then moves focus to the first item
  // itself (WAI-ARIA menu button). Later openings are the menu's own.
  const openedByKey = useRef(false);
  // Set by a touch or pen pointer down at rest, read by the click it produces. Handlers only.
  const tapping = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  useImperativeHandle(
    ref,
    () => ({ openAt: (anchor) => setMenu({ mounted: true, open: true, anchor }) }),
    [],
  );
  // An opening by the trigger hangs from it; a close keeps the point so the exit fades in place.
  const onOpenChange = useCallback(
    (open: boolean) => setMenu((m) => (open ? { mounted: true, open } : { ...m, open })),
    [],
  );
  const mount = () => setMenu({ mounted: true, open: true });
  const atRest = {
    onPointerDown(e: PointerEvent) {
      tapping.current = e.pointerType !== "mouse";
      if (tapping.current || e.button !== 0 || e.ctrlKey) return;
      e.preventDefault(); // as Radix's trigger: focus stays where the menu will put it
      mount();
    },
    onClick() {
      if (!tapping.current) return;
      tapping.current = false;
      mount();
    },
    onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault(); // the keypress opens the menu; it never also clicks
      openedByKey.current = true;
      mount();
    },
  };
  const button = (
    <TriggerButton
      ref={trigger}
      label={state === "copied" ? "Copied" : label}
      focusable={focusable}
      shown={state !== "idle"}
      nested={nested}
      position={place.trigger}
      {...(menu.mounted ? {} : atRest)}
    >
      <CopyIcon
        state={state}
        instant={instant}
        idle={<Ellipsis aria-hidden="true" className="size-3.5" />}
      />
    </TriggerButton>
  );
  return (
    <>
      {menu.mounted ? (
        <AdaptiveMenu
          open={menu.open}
          onOpenChange={onOpenChange}
          title={typeof title === "function" ? title() : title}
          anchor={menu.anchor}
        >
          <AdaptiveMenuTrigger asChild>{button}</AdaptiveMenuTrigger>
          <RowMenuContent
            items={items}
            callShown={callShown}
            onToggleCall={onToggleCall}
            onCopy={copy}
            openedByKey={openedByKey}
            trigger={trigger}
          />
        </AdaptiveMenu>
      ) : (
        button
      )}
      {state === "failed" && <CopyFailed className={`absolute ${place.failed}`} />}
    </>
  );
}

function TriggerButton({
  ref,
  label,
  focusable,
  shown,
  nested,
  position,
  children,
  ...rest
}: {
  ref?: Ref<HTMLButtonElement>;
  label: string;
  focusable: boolean;
  shown: boolean;
  nested: boolean;
  position: string;
  children: ReactNode;
  onPointerDown?(e: PointerEvent): void;
  onClick?(e: MouseEvent): void;
  onKeyDown?(e: KeyboardEvent): void;
}) {
  return (
    <Button
      ref={ref}
      type="button"
      variant="ghost"
      size="icon-xs"
      data-copy-link
      data-row-menu
      aria-haspopup="menu"
      aria-label={label}
      tabIndex={focusable ? 0 : -1}
      // Feedback stays visible after the pointer leaves.
      className={`${shown ? "inline-flex" : "hidden"} ${position} ${nested ? TRIGGER_NESTED : TRIGGER} ${COARSE}`}
      {...rest}
    >
      {children}
    </Button>
  );
}

/** Mounted from the first activation on, so the pointer query and the item list cost nothing at
 *  rest. Content props reach the desktop dropdown; the drawer takes the focus handlers. */
function RowMenuContent({
  items: source,
  callShown,
  onToggleCall,
  onCopy,
  openedByKey,
  trigger,
}: {
  items: readonly RowMenuItem[] | (() => readonly RowMenuItem[]);
  callShown: boolean;
  onToggleCall?(): void;
  onCopy(text: string, viaKeyboard: boolean): void;
  openedByKey: RefObject<boolean>;
  trigger: RefObject<HTMLButtonElement | null>;
}) {
  const items = useMemo(() => (typeof source === "function" ? source() : source), [source]);
  const touch = useMedia("(pointer: coarse)");
  // An item chosen with Enter or Space arrives as a click with detail 0: its feedback is instant.
  const viaKeyboard = useRef(false);
  const interactedOutside = useRef(false);
  const onClick = (e: MouseEvent) => {
    viaKeyboard.current = e.detail === 0;
  };
  return (
    <AdaptiveMenuContent
      align="end"
      // Radix focuses the content itself when it opens; on a keyboard first opening that focus moves
      // on to the first item.
      onFocus={(e) => {
        if (!openedByKey.current || e.target !== e.currentTarget) return;
        openedByKey.current = false;
        e.currentTarget
          .querySelector<HTMLElement>('[role="menuitem"]:not([data-disabled])')
          ?.focus();
      }}
      onInteractOutside={() => {
        interactedOutside.current = true;
      }}
      onCloseAutoFocus={(e) => {
        // Radix would focus the trigger, but once closed it is display:none again (the modal menu
        // took the row's hover and focus-within), so focus would fall to <body>. Shown for the call,
        // it takes focus, and focus-within keeps it shown. A click elsewhere keeps its own focus.
        e.preventDefault();
        const outside = interactedOutside.current;
        interactedOutside.current = false;
        const t = trigger.current;
        if (outside || !t) return;
        t.setAttribute("data-returning", "");
        t.focus({ preventScroll: true });
        t.removeAttribute("data-returning");
      }}
    >
      {items.map((item) => {
        switch (item.kind) {
          case "copy":
            return (
              <AdaptiveMenuItem
                key={item.label}
                onClick={onClick}
                onSelect={() => onCopy(item.text, viaKeyboard.current)}
              >
                {item.label}
              </AdaptiveMenuItem>
            );
          case "call":
            return (
              <AdaptiveMenuItem key={item.label} onSelect={() => onToggleCall?.()}>
                {callShown ? "Hide tool call" : item.label}
              </AdaptiveMenuItem>
            );
          case "inbox":
            return <InboxItem key={item.label} messageId={item.messageId} label={item.label} />;
          case "session":
            return (
              <AdaptiveMenuItem key={item.label} asChild>
                <Link
                  to="/agents/$slug"
                  params={{ slug: item.to }}
                  search={{ message: item.messageId }}
                  aria-label={`View this message in @${item.to}'s session`}
                >
                  {item.label}
                </Link>
              </AdaptiveMenuItem>
            );
          default:
            // The time: touch only, where the gutter time never shows.
            return touch ? (
              <AdaptiveMenuLabel
                key={item.label}
                className="text-[0.8125rem] font-normal text-muted-foreground tabular-nums"
              >
                {item.label}
              </AdaptiveMenuLabel>
            ) : null;
        }
      })}
    </AdaptiveMenuContent>
  );
}

/** "Open in inbox" for a send to a human: your inbox item for that message, from the inbox's loaded
 *  pages (fetched when the menu opens, if they aren't yet). No item of yours, no action. */
function InboxItem({ messageId, label }: { messageId: string; label: string }) {
  const select = useCallback(
    (d: InfiniteData<{ items: { id: string; messageId: string }[] }>) => {
      for (const page of d.pages)
        for (const i of page.items) if (i.messageId === messageId) return i.id;
      return undefined;
    },
    [messageId],
  );
  const id = useInfiniteQuery({ ...inboxQueryOptions, select }).data;
  if (id === undefined) return null;
  return (
    <AdaptiveMenuItem asChild>
      <Link to="/inbox" search={{ item: id }}>
        {label}
      </Link>
    </AdaptiveMenuItem>
  );
}
