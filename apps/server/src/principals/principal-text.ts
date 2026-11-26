import {
  applyTags,
  plainTagWarning,
  scanTags,
  type TagLookup,
  type TagPrincipal,
  unknownRefError,
} from "@open-factory/shared/tags";
import { ApiError, FieldError } from "../errors.ts";
import { principalsByHandles, principalsByRefs, type Tx } from "./principal-store.ts";

/** What a human sees on the field that holds an unknown tag. At most 40 characters (the I4 form rule). */
export const UNKNOWN_TAG_FIELD_MESSAGE = "Tag isn't anyone here";

/**
 * A tag-holding field names a ref nobody has. For an agent it is a tool error (its message is the sentences that say
 * what to do), and nothing is written.
 */
export class UnknownTagsError extends ApiError {
  constructor(readonly refs: string[]) {
    super(400, "unknown_tag", refs.map(unknownRefError).join("\n"));
    this.name = "UnknownTagsError";
  }
}

/**
 * Spec §4.3: scan the text, make one query by ref (the tokens) and one by handle (the plain names and the token names),
 * then rewrite every tag to `<@ref>`. Only an agent's plain `@handle` resolves; a human's stays text. An unknown ref
 * throws. Warnings are the plain-tag sentences. Pass the transaction the write runs in.
 */
export async function resolveText(
  tx: Tx,
  text: string,
  writer: "agent" | "human",
): Promise<{ text: string; refs: string[]; warnings: string[] }> {
  const scan = scanTags(text);
  if (!scan.tokens.length && !scan.plain.length) return { text, refs: [], warnings: [] };
  const resolvePlain = writer === "agent";
  const handles = new Set(scan.tokens.map((t) => t.name));
  if (resolvePlain) for (const p of scan.plain) handles.add(p.name);
  const [byRef, byHandle] = await Promise.all([
    principalsByRefs(tx, [...new Set(scan.tokens.map((t) => t.ref))]),
    principalsByHandles(tx, [...handles]),
  ]);
  const lookup: TagLookup = { byRef, byHandle };
  const applied = applyTags(text, scan, lookup, { resolvePlain });
  if (applied.unknownRefs.length) throw new UnknownTagsError(applied.unknownRefs);
  return {
    text: applied.text,
    refs: applied.refs,
    warnings: [...new Set(applied.warnings.map(plainTagWarning))],
  };
}

/**
 * `resolveText` for a named field: a human's unknown tag is a 400 on that field (`unknown_tag`), an agent's throws
 * `UnknownTagsError`. Warnings are pushed onto `warnings`, deduplicated by the caller's result.
 */
export async function resolveField(
  tx: Tx,
  text: string,
  writer: "agent" | "human",
  field: string,
  warnings?: string[],
): Promise<{ text: string; refs: string[] }> {
  try {
    const r = await resolveText(tx, text, writer);
    if (warnings) for (const w of r.warnings) if (!warnings.includes(w)) warnings.push(w);
    return { text: r.text, refs: r.refs };
  } catch (e) {
    if (e instanceof UnknownTagsError && writer === "human")
      throw new FieldError(field, UNKNOWN_TAG_FIELD_MESSAGE, "unknown_tag");
    throw e;
  }
}

/** For rendering: one query for every ref in the texts. An unknown ref gives `undefined`. */
export async function tagLookupFor(
  tx: Tx,
  texts: readonly string[],
): Promise<(ref: string) => TagPrincipal | undefined> {
  const refs = new Set<string>();
  for (const t of texts) for (const tok of scanTags(t).tokens) refs.add(tok.ref);
  const byRef = await principalsByRefs(tx, [...refs]);
  return (ref) => byRef.get(ref);
}
