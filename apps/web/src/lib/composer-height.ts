/** Bottom-docked composers (the session and inbox-reply composers) publish their height as
 *  `--composer-h` on <html>: the maximum over the mounted ones, 0 when none, so a toast never covers one
 *  and one composer unmounting never zeroes the lift while another is still mounted (spec §10.1).
 *  They also publish `--composer-inset-right`, the room right of the widest-inset composer (Agent details beside
 *  the session column), so a toast's width stays inside the content column at large text sizes. */
type Entry = { el: HTMLElement; observer: ResizeObserver; height: number; width: number };

const entries = new Map<string, Entry>();
let frame = 0;
let written = 0;
let writtenInset = 0;

function flush() {
  frame = 0;
  let max = 0;
  let inset = 0;
  const vw = document.documentElement.clientWidth;
  for (const e of entries.values()) {
    max = Math.max(max, e.height);
    inset = Math.max(inset, Math.round(vw - e.el.getBoundingClientRect().right));
  }
  if (max !== written) {
    written = max;
    document.documentElement.style.setProperty("--composer-h", `${max}px`);
  }
  if (inset !== writtenInset) {
    writtenInset = inset;
    document.documentElement.style.setProperty("--composer-inset-right", `${inset}px`);
  }
}

function schedule() {
  if (!frame) frame = requestAnimationFrame(flush);
}

/** Starts publishing `el`'s height under `id` (one ResizeObserver per element); returns the unregister. */
export function registerDockedComposer(id: string, el: HTMLElement): () => void {
  entries.get(id)?.observer.disconnect();
  const entry: Entry = {
    el,
    height: 0,
    width: 0,
    observer: new ResizeObserver((records) => {
      const last = records.at(-1);
      if (!last) return;
      const height = last.borderBoxSize?.[0]?.blockSize ?? last.contentRect.height;
      const width = last.borderBoxSize?.[0]?.inlineSize ?? last.contentRect.width ?? 0;
      if (height === entry.height && width === entry.width) return;
      entry.height = height;
      entry.width = width;
      schedule();
    }),
  };
  entries.set(id, entry);
  entry.observer.observe(el);
  return () => {
    if (entries.get(id) !== entry) return;
    entry.observer.disconnect();
    entries.delete(id);
    schedule();
  };
}
