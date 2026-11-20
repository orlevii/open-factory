import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

/** Before `@`: start, or not a letter/digit/_ and not / . @ ; after the name: not a letter/digit/_. */
const MENTION = /(?<![\p{L}\p{N}_/.@])@([a-z0-9][a-z0-9-]*)(?![\p{L}\p{N}_-])/gu;

type Node = {
  type: string;
  value?: string;
  url?: string;
  children?: Node[];
  position?: { start: { offset?: number }; end?: { offset?: number } };
};

/**
 * Each text node is matched on its own source slice (`position.start/end.offset`), so entities (`&amp;`) and escapes
 * never shift an offset, and there is no search fallback: an escaped `\\@or` is skipped by looking at the source.
 *
 * Spec §8: the names mentioned outside code, through the same micromark+GFM parser react-markdown uses. */
export function extractMentions(markdown: string): { names: string[]; skipped: string[] } {
  const tree = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  }) as Node;
  const out: string[] = [];
  // Kept in the result shape for callers; with source slices nothing is ever skipped.
  const skipped: string[] = [];
  const visit = (n: Node) => {
    if (n.type === "code" || n.type === "inlineCode") return;
    // An autolink or bare URL: a link whose only text is its own URL.
    if (
      n.type === "link" &&
      n.children?.length === 1 &&
      n.children[0]?.type === "text" &&
      (n.children[0].value === n.url || `mailto:${n.children[0].value}` === n.url)
    )
      return;
    if (
      n.type === "text" &&
      n.position?.start.offset !== undefined &&
      n.position.end?.offset !== undefined
    ) {
      // Matched on the node's own source slice, so decoded entities and dropped escapes never shift an offset.
      const start = n.position.start.offset;
      const src = markdown.slice(start, n.position.end.offset);
      for (const hit of src.matchAll(MENTION)) {
        const i = hit.index ?? 0;
        // A boundary at the slice's start: look at the source character before it.
        if (i === 0 && start > 0 && /[\p{L}\p{N}_/.@]/u.test(markdown[start - 1] ?? "")) continue;
        // `\@or`: an escaped `@` is not a mention.
        if (src[i - 1] === "\\") continue;
        const name = (hit[1] ?? "").replace(/-+$/, "");
        if (name && !out.includes(name)) out.push(name);
      }
      return;
    }
    for (const c of n.children ?? []) visit(c);
  };
  visit(tree);
  return { names: out, skipped };
}
