import { ApiError } from "@open-factory/shared";
import { Toaster as Sonner, toast } from "sonner";
import { useIsMobile } from "@/hooks/use-mobile";
import { MODAL_SELECTOR } from "@/lib/shortcuts";

export type Notification = {
  text: string;
  action?: { label: string; run(): void };
  undo?: () => Promise<void>;
};

const MIN_MS = 5000;
const PER_CHAR_MS = 60;
/** Touch has no hover-pause, so a longer text stays longer. */
export const toastDuration = (text: string) => Math.max(MIN_MS, text.length * PER_CHAR_MS);

const BUTTON =
  "ml-auto inline-flex h-7 shrink-0 items-center rounded-md px-2 text-[13px] font-medium text-foreground transition-colors duration-150 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50";
const CLASS_NAMES = {
  toast:
    "flex w-full items-center gap-2 rounded-md border border-float-edge bg-popover px-3 py-2 text-[13px] leading-[18px] text-popover-foreground",
  content: "min-w-0 flex-1",
  title: "text-[13px] leading-[18px]",
  actionButton: BUTTON,
};
const TOAST_OPTIONS = { unstyled: true, classNames: CLASS_NAMES };
const DESKTOP_OFFSET = {
  bottom: "calc(16px + var(--composer-h, 0px))",
  left: "calc(var(--sidebar-current-width) + 16px)",
};
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
      visibleToasts={3}
      expand
      toastOptions={TOAST_OPTIONS}
    />
  );
}

const held: Notification[] = [];
let observer: MutationObserver | undefined;

function modalOpen() {
  return document.querySelector(MODAL_SELECTOR) !== null;
}

/** Radix's hideOthers marks the toaster's subtree aria-hidden while a modal is open and clears it a
 *  moment after the modal's state flips to closed; a toast shown before then would not be announced. */
function hidden() {
  return document.querySelector('section[aria-label^="Notifications"]')?.closest('[aria-hidden="true"]') != null;
}

function release() {
  if (modalOpen() || hidden()) return;
  observer?.disconnect();
  observer = undefined;
  for (const n of held.splice(0)) show(n);
}

function hold(n: Notification) {
  held.push(n);
  if (observer) return;
  observer = new MutationObserver(release);
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
