import { scanMentions } from "@open-factory/shared/mentions";

/** Who did a session event's thing, from its `by` or `subject.left.by`: a mention names its principal by ref (rendered as a
 *  `Mention`, so it shows the current handle), `@factory` is the inactivity TTL ("after 3 days without activity", never
 *  "@factory"), and any other text is a word. Callers render it, since each places it in its own sentence. */
export type By =
  | { kind: "mention"; ref: string }
  | { kind: "ttl" }
  | { kind: "word"; text: string };

export function formatBy(by: string): By {
  if (by === "@factory") return { kind: "ttl" };
  const [t] = scanMentions(by).tokens;
  return t ? { kind: "mention", ref: t.ref } : { kind: "word", text: by };
}
