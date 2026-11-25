import { TriangleAlert } from "lucide-react";

/**
 * "Latest · auto-updates" (spec §10.5): a declaration with no `ref` runs the marketplace's newest code at each restart.
 * The icon and the words carry it, never colour alone. The icon is `aria-hidden`, the visible words are the text, and
 * the `·` is an `aria-hidden` span with a visually hidden comma in its place for a screen reader.
 */
export function LatestBadge() {
  return (
    <span className="inline-flex items-center gap-1 text-[0.8125rem] text-warning">
      <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />
      <span>Latest</span>
      <span aria-hidden="true">·</span>
      <span className="sr-only">, </span>
      <span>auto-updates</span>
    </span>
  );
}
