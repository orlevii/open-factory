import { User } from "lucide-react";
import { memo } from "react";

const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "phd", "md"]);
const LETTER = /^\p{L}/u;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The first grapheme of a word that is a letter (an emoji or a digit before it is skipped), uppercased. */
function firstLetter(word: string): string | undefined {
  for (const { segment } of segmenter.segment(word)) if (LETTER.test(segment)) return segment;
  return undefined;
}

/**
 * A person's initials: the first and the last word's first letter, by grapheme, skipping a trailing suffix
 * ("Jr.", "III"). One word gives one letter. Names with no letter at all (empty, an emoji) give "".
 */
export function initialsOf(name: string): string {
  const words = name.split(/\s+/).filter((w) => firstLetter(w) !== undefined);
  while (words.length > 1 && SUFFIXES.has((words.at(-1) ?? "").replace(/\W/gu, "").toLowerCase()))
    words.pop();
  const first = firstLetter(words[0] ?? "");
  const last = words.length > 1 ? firstLetter(words.at(-1) ?? "") : undefined;
  return `${first ?? ""}${last ?? ""}`.toLocaleUpperCase();
}

/**
 * A human's avatar: initials on neutral steel, never an agent hue. A person glyph when the name has no letters.
 * Decorative: the name always sits beside it.
 */
export const HumanAvatar = memo(function HumanAvatar({
  name,
  size = 20,
}: {
  name: string;
  size?: 16 | 20;
}) {
  const initials = initialsOf(name);
  return (
    <span
      data-human-avatar
      aria-hidden="true"
      style={{ width: size, height: size }}
      className="inline-flex shrink-0 select-none items-center justify-center rounded-full border border-border bg-secondary font-medium leading-none text-secondary-foreground"
    >
      {initials ? (
        <span className={size === 16 ? "text-[0.5rem]" : "text-[0.5625rem]"}>{initials}</span>
      ) : (
        <User width={size * 0.6} height={size * 0.6} strokeWidth={2} />
      )}
    </span>
  );
});
