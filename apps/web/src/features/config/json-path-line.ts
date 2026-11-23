const FOUND = Symbol("found");
const SCALAR_END = /[\s,}\]]/;

/**
 * The 1-based line of the value at a dotted overlay path (an issue's or a conflict's `path`) in JSON text: a key's own
 * line, or a list element's. A path the text doesn't have answers with its deepest present ancestor, and none with
 * `undefined`. Keys are compared as whole names, so a key holding a dot (`ctx.io`) still matches. Pure and tolerant:
 * invalid JSON never throws, and the part read before the error still answers.
 */
export function jsonPathToLine(text: string, path: string): number | undefined {
  let i = 0;
  let line = 1;
  // The deepest ancestor of `path` seen so far, by the length of its dotted name.
  let best: { len: number; line: number } | undefined;

  const space = () => {
    while (i < text.length) {
      const c = text[i];
      if (c === "\n") line++;
      else if (c !== " " && c !== "\t" && c !== "\r") return;
      i++;
    }
  };

  const hit = (segs: readonly string[], at: number) => {
    const joined = segs.join(".");
    if (joined === path) {
      best = { len: Number.POSITIVE_INFINITY, line: at };
      throw FOUND;
    }
    if (segs.length > 0 && path.startsWith(`${joined}.`) && (!best || joined.length > best.len))
      best = { len: joined.length, line: at };
  };

  const string = (): string => {
    if (text[i] !== '"') throw new Error("string");
    const start = i++;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\\") i++;
      else if (text[i] === "\n") line++;
      i++;
    }
    if (i >= text.length) throw new Error("unterminated");
    i++;
    const raw = text.slice(start, i);
    try {
      return JSON.parse(raw) as string;
    } catch {
      return raw.slice(1, -1);
    }
  };

  const value = (segs: readonly string[], at: number) => {
    hit(segs, at);
    const c = text[i];
    if (c === "{") {
      i++;
      space();
      if (text[i] === "}") return void i++;
      for (;;) {
        space();
        const keyLine = line;
        const key = string();
        space();
        if (text[i] !== ":") throw new Error("colon");
        i++;
        space();
        value([...segs, key], keyLine);
        space();
        if (text[i] === ",") i++;
        else if (text[i] === "}") return void i++;
        else throw new Error("object");
      }
    }
    if (c === "[") {
      i++;
      space();
      if (text[i] === "]") return void i++;
      for (let n = 0; ; n++) {
        space();
        value([...segs, String(n)], line);
        space();
        if (text[i] === ",") i++;
        else if (text[i] === "]") return void i++;
        else throw new Error("array");
      }
    }
    if (c === '"') return void string();
    const start = i;
    while (i < text.length && !SCALAR_END.test(text[i] as string)) i++;
    if (i === start) throw new Error("value");
  };

  try {
    space();
    if (i >= text.length) return undefined;
    value([], line);
  } catch (e) {
    if (e === FOUND) return best?.line;
  }
  return best?.line;
}
