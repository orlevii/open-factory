import { memo } from "react";
import { Mention } from "@/components/mention/mention";
import { useHandleText } from "@/features/principals/use-principal";

const PLURAL = new Intl.PluralRules("en");
const COUNT = new Intl.NumberFormat("en");

/** "also to @dev" / "also to @dev and 8 others" after a speaker (I1 §6.4): the first other, then how
 *  many more. The full list is the group's accessible name and the row menu's Recipients item.
 *  `others` are principal refs: the handles come from the principals cache. */
export const AlsoTo = memo(function AlsoTo({ others }: { others: readonly string[] }) {
  const handleOf = useHandleText();
  const first = others[0];
  if (first === undefined) return null;
  const more = others.length - 1;
  const names = others.map((ref) => `@${handleOf(ref)}`);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset is a form control group; this names a phrase inside a line.
    <span
      role="group"
      aria-label={`Also to ${names.join(", ")}`}
      className="flex min-w-0 items-baseline gap-1 text-muted-foreground"
    >
      <span className="shrink-0">also to</span>
      <span dir="auto" className="min-w-0 truncate">
        <Mention mentionRef={first} />
      </span>
      {more > 0 && (
        <span className="shrink-0">
          and {COUNT.format(more)} {PLURAL.select(more) === "one" ? "other" : "others"}
        </span>
      )}
    </span>
  );
});
