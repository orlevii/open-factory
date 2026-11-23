/**
 * Field messages that reach a form's note line. Spec §8: at most 40 characters, no interpolated
 * user value, one rule each. `messages.test.ts` enforces the length.
 */
export const MSG = {
  startLetter: "Start with a letter.",
  nameLength: "Use 2 to 40 characters.",
  slugLength: "Use 3 to 40 characters.",
  nameChars: "Use only a–z, 0–9 and hyphens.",
  noTrailingHyphen: "Don't end with a hyphen.",
  slugReserved: "That slug is reserved.",
  handleLength: "Use 2 to 32 characters.",
  handleReserved: "That handle is reserved.",
  secretChars: "Use A–Z, 0–9 and underscores.",
  nameReserved: "That name is reserved.",
  cronFields: "Use 5 fields, like 0 9 * * 1-5.",
  cronTokens: "Use numbers, *, -, / and commas.",
  titleLength: "Use 200 characters or fewer.",
  bodyTooLong: "Shorten this to 64 KB or less.",
  hostPathStart: "Start with / or ~/.",
} as const;
