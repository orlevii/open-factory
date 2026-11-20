import { isMap, isSeq, LineCounter, parseDocument } from "yaml";

export interface ParseError {
  message: string;
  line?: number;
  column?: number;
}

export function parseYaml(text: string): {
  value?: unknown;
  error?: ParseError;
  lineOf(path: (string | number)[]): number | undefined;
} {
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, prettyErrors: false });
  // The first error is often a cascade symptom reported earlier in the file; the last points at the real fault.
  const err = doc.errors.at(-1);
  const lineOf = (p: (string | number)[]) => {
    let node: unknown = doc.contents;
    for (const k of p) {
      if (isMap(node)) node = node.get(k, true);
      else if (isSeq(node)) node = node.get(Number(k), true);
      else return undefined;
    }
    const range = (node as { range?: [number, number, number] } | null | undefined)?.range;
    return range ? lc.linePos(range[0]).line : undefined;
  };
  if (err) {
    const pos = err.linePos?.[0] ?? (err.pos ? lc.linePos(err.pos[0]) : undefined);
    return {
      error: { message: `YAML: ${err.message.split("\n")[0]}`, line: pos?.line, column: pos?.col },
      lineOf,
    };
  }
  return { value: doc.toJS() as unknown, lineOf };
}

export function parseJson(text: string): { value?: unknown; error?: ParseError } {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch (e) {
    const msg = String((e as Error).message);
    const lc = /line (\d+) column (\d+)/.exec(msg);
    if (lc)
      return { error: { message: `JSON: ${msg}`, line: Number(lc[1]), column: Number(lc[2]) } };
    const pm = /position (\d+)/.exec(msg);
    if (pm) {
      const before = text.slice(0, Number(pm[1]));
      const line = before.split("\n").length;
      const column = before.length - (before.lastIndexOf("\n") + 1) + 1;
      return { error: { message: `JSON: ${msg}`, line, column } };
    }
    return { error: { message: `JSON: ${msg}` } };
  }
}
