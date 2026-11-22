import { type AnyRouter, redirect } from "@tanstack/react-router";
import { openSheet, type SheetSpec } from "./sheet-store";

/**
 * For a legacy form URL's `beforeLoad`: open the sheet over the page `to` and redirect there.
 * Preloads (hover or focus) do nothing. No resolved location yet means the initial navigation,
 * where the sheet appears without sliding.
 */
export function sheetRedirect(
  spec: SheetSpec,
  to: string,
  opts: { preload: boolean; router: AnyRouter },
): never | undefined {
  if (opts.preload) return undefined;
  openSheet(spec, { at: to, instant: !opts.router.state.resolvedLocation });
  throw redirect({ to, replace: true });
}
