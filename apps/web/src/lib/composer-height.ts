/** Bottom-docked composers (the session and inbox-reply composers) publish their height as
 *  `--composer-h` on <html>: the maximum over the mounted ones, 0 when none, so a toast never covers one
 *  and one composer unmounting never zeroes the lift while another is still mounted (spec §10.1). */
type Entry = { observer: ResizeObserver; height: number };

const entries = new Map<string, Entry>();
let frame = 0;
let written = 0;

function flush() {
  frame = 0;
  let max = 0;
  for (const e of entries.values()) max = Math.max(max, e.height);
  if (max === written) return;
  written = max;
  document.documentElement.style.setProperty("--composer-h", `${max}px`);
}

function schedule() {
  if (!frame) frame = requestAnimationFrame(flush);
}

/** Starts publishing `el`'s height under `id` (one ResizeObserver per element); returns the unregister. */
export function registerDockedComposer(id: string, el: HTMLElement): () => void {
  entries.get(id)?.observer.disconnect();
  const entry: Entry = {
    height: 0,
    observer: new ResizeObserver((records) => {
      const last = records.at(-1);
      if (!last) return;
      const height = last.borderBoxSize?.[0]?.blockSize ?? last.contentRect.height;
      if (height === entry.height) return;
      entry.height = height;
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
