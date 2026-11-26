import { scanTags } from "@open-factory/shared/tags";

/** Who did a session event's thing, from its `by` or `subject.left.by`: a tag names its principal by ref (rendered as a
 *  `Tag`, so it shows the current handle), `@factory` is the inactivity TTL ("after 3 days without activity", never
 *  "@factory"), and any other text is a word. Callers render it, since each places it in its own sentence. */
export type By = { kind: "tag"; ref: string } | { kind: "ttl" } | { kind: "word"; text: string };

export function formatBy(by: string): By {
  if (by === "@factory") return { kind: "ttl" };
  const [t] = scanTags(by).tokens;
  return t ? { kind: "tag", ref: t.ref } : { kind: "word", text: by };
}
