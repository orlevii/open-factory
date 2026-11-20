import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

/** Before `@`: start, or not a letter/digit/_ and not / . @ ; after the name: not a letter/digit/_. */
const MENTION = /(?<![\p{L}\p{N}_/.@])@([a-z0-9][a-z0-9-]*)(?![\p{L}\p{N}_])/gu;

type Node = {
  type: string;
  value?: string;
  url?: string;
  children?: Node[];
  position?: { start: { offset?: number } };
};

/**
 * Limitation: text-node offsets map to the source only when no escape precedes the `@` in the same node, so a mention
 * placed after an escape (`\\* @or`) may be missed. It is reported in `skipped`, never guessed: a fallback search could
 * land on a deliberately escaped `\\@or` and turn it into a mention.
 *
 * Spec §8: the names mentioned outside code, through the same micromark+GFM parser react-markdown uses. */
export function extractMentions(markdown: string): { names: string[]; skipped: string[] } {
  const tree = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  }) as Node;
  const out: string[] = [];
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
    if (n.type === "text" && n.value) {
      const base = n.position?.start.offset ?? 0;
      for (const hit of n.value.matchAll(MENTION)) {
        // `\@or`: the escape vanished from the AST; read the source.
        const at = base + (hit.index ?? 0);
        if (markdown[at] !== "@") {
          // offset drifted after an earlier escape: skip, never guess (limitation, see note)
          const n2 = (hit[1] ?? "").replace(/-+$/, "");
          if (n2 && !skipped.includes(n2)) skipped.push(n2);
          continue;
        }
        if (markdown[at - 1] === "\\") continue;
        const name = (hit[1] ?? "").replace(/-+$/, "");
        if (name && !out.includes(name)) out.push(name);
      }
      return;
    }
    for (const c of n.children ?? []) visit(c);
  };
  visit(tree);
  return { names: out, skipped: skipped.filter((n) => !out.includes(n)) };
}
