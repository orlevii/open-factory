import { ApiError } from "@open-factory/shared";
import type { CSSProperties } from "react";
import { Toaster as Sonner, toast } from "sonner";
import { useIsMobile } from "@/hooks/use-mobile";
import { MODAL_SELECTOR } from "@/lib/shortcuts";

export type Notification = {
  text: string;
  action?: { label: string; run(): void };
  undo?: () => Promise<void>;
};

/** Sonner's container label (it appends the hotkey hint, so select by prefix); the release check and the tests select by it, never by Sonner's default. */
export const TOASTER_LABEL = "Toast notifications";

const MIN_MS = 5000;
const PER_CHAR_MS = 60;
/** Touch has no hover-pause, so a longer text stays longer. */
export const toastDuration = (text: string) => Math.max(MIN_MS, text.length * PER_CHAR_MS);

// rem, so toasts follow the text size like the rest of the UI (WCAG 1.4.4).
const BUTTON =
  "ml-auto inline-flex h-7 shrink-0 items-center rounded-md px-2 text-[0.8125rem] font-medium text-foreground transition-colors duration-150 hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50";
const CLASS_NAMES = {
  toast:
    "flex w-full items-center gap-2 rounded-md border border-float-edge bg-popover px-3 py-2 text-[0.8125rem] leading-[1.125rem] text-popover-foreground",
  content: "min-w-0 flex-1",
  title: "text-[0.8125rem] leading-[1.125rem]",
  actionButton: BUTTON,
};
const TOAST_OPTIONS = { unstyled: true, classNames: CLASS_NAMES };
const DESKTOP_OFFSET = {
  bottom: "calc(16px + var(--composer-h, 0px))",
  left: "calc(var(--sidebar-current-width) + 16px)",
};
/** Sonner's 356px, but never past the content column: 16px gutters each side of the area right of the sidebar, less
 *  what sits right of a docked composer (Agent details beside the session). Phones: Sonner's own full-width rule. */
const DESKTOP_STYLE = {
  "--width":
    "min(356px, calc(100vw - var(--sidebar-current-width, 0px) - 32px - var(--composer-inset-right, 0px)))",
} as CSSProperties;
const PHONE_OFFSET = {
  bottom: "calc(16px + var(--composer-h, 0px) + env(safe-area-inset-bottom))",
};

/** One <Toaster /> in the _app layout; nothing else imports sonner. */
export function Toaster() {
  const mobile = useIsMobile();
  return (
    <Sonner
      position={mobile ? "bottom-center" : "bottom-left"}
      offset={mobile ? PHONE_OFFSET : DESKTOP_OFFSET}
      mobileOffset={mobile ? PHONE_OFFSET : DESKTOP_OFFSET}
      containerAriaLabel={TOASTER_LABEL}
      visibleToasts={3}
      gap={8}
      expand
      style={mobile ? undefined : DESKTOP_STYLE}
      toastOptions={TOAST_OPTIONS}
    />
  );
}

const held: Notification[] = [];
let observer: MutationObserver | undefined;
/** The pending release check: at most one per animation frame, however many mutations land in it. */
let frame: number | undefined;

function modalOpen() {
  return document.querySelector(MODAL_SELECTOR) !== null;
}

/** Radix's hideOthers marks the toaster's subtree aria-hidden while a modal is open and clears it a
 *  moment after the modal's state flips to closed; a toast shown before then would not be announced. */
function hidden() {
  return document.querySelector(`section[aria-label^="${TOASTER_LABEL}"]`)?.closest('[aria-hidden="true"]') != null;
}

function release() {
  if (modalOpen() || hidden()) return;
  observer?.disconnect();
  observer = undefined;
  for (const n of held.splice(0)) show(n);
}

function scheduleRelease() {
  if (frame !== undefined) return;
  frame = requestAnimationFrame(() => {
    frame = undefined;
    release();
  });
}

function hold(n: Notification) {
  held.push(n);
  if (observer) return;
  observer = new MutationObserver(scheduleRelease);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["data-state", "aria-modal", "aria-hidden"],
  });
}

function show({ text, action, undo }: Notification) {
  let undone = false;
  const label = undo ? "Undo" : action?.label;
  toast(text, {
    duration: toastDuration(text),
    action:
      label === undefined
        ? undefined
        : {
            label,
            onClick: (e) => {
              if (!undo) return action?.run();
              if (undone) return e.preventDefault();
              undone = true;
              (e.currentTarget as HTMLButtonElement).disabled = true;
              Promise.resolve()
                .then(undo)
                .catch((err: unknown) =>
                notify({
                  text:
                    err instanceof ApiError ? err.message : "Couldn't undo: can't reach the server.",
                }),
              );
            },
          },
  });
}

/** Shows a toast. While a modal layer is open it is held (the modal marks the toaster aria-hidden, so
 *  it would not be announced) and shown when the last one closes. */
export function notify(n: Notification): void {
  if (held.length > 0 || modalOpen()) hold(n);
  else show(n);
}

/** Sign-out: drop held toasts (they belong to the previous user) and stop watching for the modal to close. */
export function resetToasts() {
  held.length = 0;
  observer?.disconnect();
  observer = undefined;
  if (frame !== undefined) cancelAnimationFrame(frame);
  frame = undefined;
}
