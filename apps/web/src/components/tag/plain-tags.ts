import { renderTags } from "@open-factory/shared/tags";
import { useMemo } from "react";
import { usePrincipalLookup } from "@/features/principals/use-principal";

/** The text with each `<@ref>` as `@handle`, for surfaces that can't show a chip (a row title, the document title). */
export function usePlainTags(text: string): string {
  const lookup = usePrincipalLookup();
  return useMemo(() => renderTags(text, lookup, "plain"), [text, lookup]);
}
