import { normaliseRef } from "@open-factory/shared";

/** A mention-looking token in text: `<@ref>` or `<@ref|label>` (the label is ignored). Whether the ref is real is `normaliseRef`'s call. */
const MENTION = /<@([0-9A-Za-z]{8})(?:\|[^<>\n]*)?>/g;

type MdNode = { type: string; value?: string; children?: MdNode[]; data?: unknown };

function split(node: MdNode): MdNode[] | undefined {
  const value = node.value ?? "";
  const out: MdNode[] = [];
  let at = 0;
  for (const m of value.matchAll(MENTION)) {
    const mentionRef = normaliseRef(m[1] ?? "");
    if (!mentionRef) continue;
    const start = m.index ?? 0;
    if (start > at) out.push({ type: "text", value: value.slice(at, start) });
    out.push({ type: "mention", data: { hName: "of-mention", hProperties: { mentionRef } } });
    at = start + m[0].length;
  }
  if (out.length === 0) return undefined;
  if (at < value.length) out.push({ type: "text", value: value.slice(at) });
  return out;
}

function walk(node: MdNode): void {
  const children = node.children;
  if (!children) return;
  // Code never has `text` children (its value is on the node), so only prose is split.
  for (let i = 0; i < children.length; i++) {
    const child = children[i] as MdNode;
    if (child.type === "text") {
      const parts = split(child);
      if (parts) {
        children.splice(i, 1, ...parts);
        i += parts.length - 1;
      }
    } else if (child.type !== "code" && child.type !== "inlineCode") walk(child);
  }
}

/** Turns `<@ref>` text into `of-mention` elements that `Markdown` renders as chips. Never inside code. */
export function remarkMentions() {
  return (tree: MdNode) => walk(tree);
}
