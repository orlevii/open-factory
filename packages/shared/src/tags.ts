import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { HANDLE_PATTERN } from "./handle.ts";
import { normaliseRef } from "./ref.ts";

/** The only two tag shapes that may pass a sanitiser: <@ref> and <@ref|handle>. Global; use matchAll / replace. */
export const TAG_SHAPE = /<@[0-9a-hjkmnp-tv-z]{8}(?:\|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)?>/g;

/** Before `@`: start, or not a letter/digit/_ and not / . @ ; after the name: not a letter/digit/_ or hyphen. */
const MENTION = /(?<![\p{L}\p{N}_/.@])@([a-z0-9][a-z0-9-]*)(?![\p{L}\p{N}_-])/gu;
/** A tag-looking token: its name may be a ref (any case, with look-alikes) or a handle written in its place. */
const TOKEN = /<@([0-9A-Za-z][0-9A-Za-z-]*)(?:\|[^<>\n]*)?>/g;
const TRAILING_HYPHENS = /-+$/;

export type TagToken = { ref: string; start: number; end: number; name: string };
export type PlainCandidate = { name: string; start: number; end: number };
export type TagScan = { tokens: TagToken[]; plain: PlainCandidate[] };
export type TagPrincipal = { ref: string; handle: string };
export type TagLookup = {
  byRef: ReadonlyMap<string, TagPrincipal>;
  byHandle: ReadonlyMap<string, TagPrincipal>;
};
export type TagWarning = { written: string; ref: string; handle: string };
export type AppliedTags = {
  text: string;
  refs: string[];
  warnings: TagWarning[];
  unknownRefs: string[];
};

type Node = {
  type: string;
  value?: string;
  url?: string;
  children?: Node[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};
type Range = [start: number, end: number];

function span(n: Node): Range | undefined {
  const start = n.position?.start.offset;
  const end = n.position?.end.offset;
  return start === undefined || end === undefined ? undefined : [start, end];
}

/** Source ranges where a tag or mention is not parsed: code, URLs, and a link's target (its text still counts). */
function excludedRanges(text: string): Range[] {
  const tree = fromMarkdown(text, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  }) as Node;
  const out: Range[] = [];
  const visit = (n: Node) => {
    const own = span(n);
    if (n.type === "code" || n.type === "inlineCode") {
      if (own) out.push(own);
      return;
    }
    if (n.type === "link" && own) {
      const kids = n.children ?? [];
      const only = kids[0];
      // An autolink or bare URL: a link whose only text is its own URL.
      if (
        kids.length === 1 &&
        only?.type === "text" &&
        (only.value === n.url || `mailto:${only.value}` === n.url)
      ) {
        out.push(own);
        return;
      }
      let at = own[0];
      for (const c of kids) {
        const r = span(c);
        if (!r) continue;
        if (r[0] > at) out.push([at, r[0]]);
        at = r[1];
      }
      if (own[1] > at) out.push([at, own[1]]);
    }
    for (const c of n.children ?? []) visit(c);
  };
  visit(tree);
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

/** Binary search over ranges sorted by start (they never overlap: children sit inside one parent only once). */
function inside(ranges: Range[], i: number): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = ranges[mid] as Range;
    if (i < r[0]) hi = mid - 1;
    else if (i >= r[1]) lo = mid + 1;
    else return true;
  }
  return false;
}

/**
 * Spec §4.3: the tokens (`<@ref…>`) and plain `@name` candidates outside code and URLs, over the whole source
 * (a `|` in a table row splits cells, so per-text-node scanning would cut a label). Pure.
 */
export function scanTags(text: string): TagScan {
  const ranges = excludedRanges(text);
  const tokens: TagToken[] = [];
  const plain: PlainCandidate[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const start = m.index ?? 0;
    if (text[start - 1] === "\\" || inside(ranges, start)) continue;
    const end = start + m[0].length;
    const name = (m[1] ?? "").toLowerCase();
    const ref = normaliseRef(name);
    if (ref) tokens.push({ ref, start, end, name });
    else if (HANDLE_PATTERN.test(name)) plain.push({ name, start, end });
  }
  const taken: Range[] = [...tokens, ...plain].map((t) => [t.start, t.end]);
  taken.sort((a, b) => a[0] - b[0]);
  for (const m of text.matchAll(MENTION)) {
    const start = m.index ?? 0;
    if (text[start - 1] === "\\" || inside(ranges, start) || inside(taken, start)) continue;
    const name = (m[1] ?? "").replace(TRAILING_HYPHENS, "");
    if (name) plain.push({ name, start, end: start + 1 + name.length });
  }
  plain.sort((a, b) => a.start - b.start);
  return { tokens, plain };
}

export const tagOf = (ref: string): string => `<@${ref}>`;
export const agentTagOf = (p: TagPrincipal): string => `<@${p.ref}|${p.handle}>`;

type Edit = { start: number; end: number; hit?: TagPrincipal; unknown?: string; written?: string };

/**
 * Rewrites every known token to `<@ref>`. An unknown ref is left as written and reported. A plain `@name` (or a
 * `<@handle>` written in a ref's place) resolves on an exact handle match, only with `resolvePlain`, and warns.
 */
export function applyTags(
  text: string,
  scan: TagScan,
  lookup: TagLookup,
  opts: { resolvePlain: boolean },
): AppliedTags {
  const edits: Edit[] = [];
  for (const t of scan.tokens) {
    const known = lookup.byRef.get(t.ref);
    // A handle in a ref's place is plain: it resolves only when plain tags are allowed.
    const asHandle = known ? undefined : lookup.byHandle.get(t.name);
    if (known) edits.push({ start: t.start, end: t.end, hit: known });
    else if (asHandle && opts.resolvePlain)
      edits.push({
        start: t.start,
        end: t.end,
        hit: asHandle,
        written: text.slice(t.start, t.end),
      });
    else edits.push({ start: t.start, end: t.end, unknown: t.ref });
  }
  if (opts.resolvePlain) {
    for (const p of scan.plain) {
      const hit = lookup.byHandle.get(p.name);
      if (hit) edits.push({ start: p.start, end: p.end, hit, written: text.slice(p.start, p.end) });
    }
  }
  edits.sort((a, b) => a.start - b.start);
  const refs: string[] = [];
  const unknownRefs: string[] = [];
  const warnings: TagWarning[] = [];
  let out = "";
  let at = 0;
  for (const e of edits) {
    if (!e.hit) {
      const u = e.unknown as string;
      if (!unknownRefs.includes(u)) unknownRefs.push(u);
      continue;
    }
    out += text.slice(at, e.start) + tagOf(e.hit.ref);
    at = e.end;
    if (!refs.includes(e.hit.ref)) refs.push(e.hit.ref);
    if (e.written) warnings.push({ written: e.written, ref: e.hit.ref, handle: e.hit.handle });
  }
  return { text: out + text.slice(at), refs, warnings, unknownRefs };
}

/** Replaces tokens only: `"agent"` → `<@ref|handle>`, `"plain"` → `@handle`; an unknown ref → `unknown`. */
export function renderTags(
  text: string,
  lookup: (ref: string) => TagPrincipal | undefined,
  style: "agent" | "plain",
): string {
  let out = "";
  let at = 0;
  for (const t of scanTags(text).tokens) {
    const p = lookup(t.ref) ?? { ref: t.ref, handle: "unknown" };
    out += text.slice(at, t.start) + (style === "agent" ? agentTagOf(p) : `@${p.handle}`);
    at = t.end;
  }
  return out + text.slice(at);
}

export const plainTagWarning = (w: TagWarning): string =>
  `Plain tag detected: @${w.written.replace(/^<?@/, "").replace(/(?:\|[^>]*)?>$/, "")} was resolved to <@${w.ref}|${w.handle}>. Tag as <@ref|handle>.`;

export const unknownRefError = (ref: string): string =>
  `<@${ref}> isn't anyone in this factory; list_peers shows each agent and human with their tag.`;
