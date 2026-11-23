import { canonicalJson } from "@open-factory/shared";
import { type Document, isMap, isNode, isScalar, parseDocument } from "yaml";

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
 * text byte for byte. A scalar replaced by a scalar keeps its trailing comment. `text` must parse (the caller checks).
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
      if (isScalar(node) && (typeof want === "string" || typeof want === "number"))
        node.value = want;
      else map.set(key, want);
      changed = true;
    }
  }
  return changed ? doc.toString({ lineWidth: 0 }) : text;
}
