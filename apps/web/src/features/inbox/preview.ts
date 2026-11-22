const FENCE_LINE = /^[ \t]*(?:```|~~~).*$/gm;
const HEADING = /^[ \t]{0,3}#{1,6}[ \t]+/gm;
const QUOTE = /^[ \t]*>[ \t]?/gm;
const LIST_MARKER = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm;
const LINK = /!?\[([^\]]*)\]\([^)]*\)/g;
const INLINE_CODE = /`([^`\n]*)`/g;
const STRONG = /(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g;
const STAR_EM = /\*(?=\S)([^*\n]+?)(?<=\S)\*/g;
// Underscore emphasis only at word edges, so snake_case_names survive.
const UNDERSCORE_EM = /(?<!\w)_(?=\S)([^_\n]+?)(?<=\S)_(?!\w)/g;
const SPACE = /\s+/g;

/** A markdown message as one line of plain text, for the inbox list's preview. */
export function plainPreview(markdown: string): string {
  return markdown
    .replace(FENCE_LINE, "")
    .replace(HEADING, "")
    .replace(QUOTE, "")
    .replace(LIST_MARKER, "")
    .replace(LINK, "$1")
    .replace(INLINE_CODE, "$1")
    .replace(STRONG, "$2")
    .replace(STAR_EM, "$1")
    .replace(UNDERSCORE_EM, "$1")
    .replace(SPACE, " ")
    .trim();
}
