import { canonicalJson } from "@open-factory/shared";
import {
  type Document,
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  visit,
  type YAMLMap,
  type YAMLSeq,
} from "yaml";

/** The `template.yaml` keys the configuration form owns (I2 §12.1). Every other key is the file's own. */
export const FORM_OWNED_KEYS = [
  "model",
  "effort",
  "warm_window_minutes",
  "max_live_spawns",
  "skills",
  "plugins",
  "can_spawn",
  "secrets",
] as const;

/**
 * Sets or deletes only the form-owned keys of `text` to match `template`, through the YAML Document so comments, key
 * order and every other key survive. A key already holding the value is left alone, so an unchanged doc returns the
 * text byte for byte. A scalar replaced by a scalar keeps its trailing comment, and a list of scalars is updated in
 * place: items that stay keep their node and comments, removed ones take theirs along, added ones are appended. A node
 * with an anchor is replaced, never mutated, and its aliases are expanded to the old value, so they keep it. `text` must parse (the caller
 * checks).
 */
export function applyConfigToYaml(text: string, template: Record<string, unknown>): string {
  const doc: Document = parseDocument(text) as unknown as Document;
  if (doc.contents === null) doc.contents = doc.createNode({});
  const map = doc.contents;
  if (!isMap(map)) throw new Error("template.yaml is not a mapping");
  let changed = false;
  for (const key of FORM_OWNED_KEYS) {
    const want = template[key];
    const node = map.get(key, true);
    const have = isNode(node) ? node.toJS(doc) : node;
    if (want === undefined) {
      if (map.has(key)) {
        map.delete(key);
        changed = true;
      }
    } else if (!map.has(key) || canonicalJson(have) !== canonicalJson(want)) {
      if (isScalar(node) && !node.anchor && (typeof want === "string" || typeof want === "number"))
        node.value = want;
      else if (isSeq(node) && !node.anchor && Array.isArray(want) && updateSeq(doc, node, want)) {
        // updated in place
      } else replaceValue(doc, map, key, node, want);
      changed = true;
    }
  }
  return changed ? doc.toString({ lineWidth: 0 }) : text;
}

/** Rewrites the items of a sequence of scalars to `want`, keeping the nodes of the values that stay. False if not applicable. */
function updateSeq(doc: Document, seq: YAMLSeq, want: unknown[]): boolean {
  if (!want.every((v) => typeof v === "string" || typeof v === "number")) return false;
  if (!seq.items.every((i) => isScalar(i) && !i.anchor)) return false;
  const free = [...seq.items];
  seq.items = want.map((v) => {
    const at = free.findIndex((i) => isScalar(i) && i.value === v);
    return at < 0 ? doc.createNode(v) : (free.splice(at, 1)[0] as never);
  });
  return true;
}

/** Replaces the value of `key` with a new node (`Map.set` would mutate a scalar in place, through its anchor too). */
function replaceValue(doc: Document, map: YAMLMap, key: string, old: unknown, want: unknown) {
  const pair = map.items.find((p) => isScalar(p.key) && p.key.value === key);
  if (!pair) {
    map.set(key, want);
    return;
  }
  if (isNode(old) && !isAlias(old) && "anchor" in old && old.anchor) {
    const anchor = old.anchor;
    const was = old.toJS(doc);
    visit(doc, { Alias: (_k, a) => (a.source === anchor ? doc.createNode(was) : undefined) });
  }
  pair.value = doc.createNode(want);
}
