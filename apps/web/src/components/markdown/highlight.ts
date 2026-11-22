import type { HighlighterCore, LanguageInput } from "shiki/core";

// A short list of what agents usually write. Each grammar is its own lazy chunk, loaded on first use;
// anything else renders as plain text. Keys are the fence names we accept, values the grammar loader.
const typescript = () => import("shiki/langs/typescript.mjs");
const tsx = () => import("shiki/langs/tsx.mjs");
const javascript = () => import("shiki/langs/javascript.mjs");
const jsx = () => import("shiki/langs/jsx.mjs");
const json = () => import("shiki/langs/json.mjs");
const jsonc = () => import("shiki/langs/jsonc.mjs");
const shell = () => import("shiki/langs/shellscript.mjs");
const python = () => import("shiki/langs/python.mjs");
const diff = () => import("shiki/langs/diff.mjs");
const yaml = () => import("shiki/langs/yaml.mjs");
const markdown = () => import("shiki/langs/markdown.mjs");
const css = () => import("shiki/langs/css.mjs");
const html = () => import("shiki/langs/html.mjs");
const sql = () => import("shiki/langs/sql.mjs");
const go = () => import("shiki/langs/go.mjs");
const rust = () => import("shiki/langs/rust.mjs");
const toml = () => import("shiki/langs/toml.mjs");
const dockerfile = () => import("shiki/langs/dockerfile.mjs");
const java = () => import("shiki/langs/java.mjs");
const c = () => import("shiki/langs/c.mjs");
const cpp = () => import("shiki/langs/cpp.mjs");
const csharp = () => import("shiki/langs/csharp.mjs");
const ruby = () => import("shiki/langs/ruby.mjs");
const php = () => import("shiki/langs/php.mjs");
const swift = () => import("shiki/langs/swift.mjs");
const kotlin = () => import("shiki/langs/kotlin.mjs");
const xml = () => import("shiki/langs/xml.mjs");
const graphql = () => import("shiki/langs/graphql.mjs");
const make = () => import("shiki/langs/make.mjs");
const scss = () => import("shiki/langs/scss.mjs");
const ini = () => import("shiki/langs/ini.mjs");
const lua = () => import("shiki/langs/lua.mjs");
const shellsession = () => import("shiki/langs/shellsession.mjs");
const powershell = () => import("shiki/langs/powershell.mjs");
const hcl = () => import("shiki/langs/hcl.mjs");
const proto = () => import("shiki/langs/proto.mjs");
const dotenv = () => import("shiki/langs/dotenv.mjs");

type GrammarLoader = () => Promise<{ default: LanguageInput }>;

const GRAMMARS: Record<string, { id: string; load: GrammarLoader }> = {};
function add(id: string, load: GrammarLoader, aliases: string[] = []) {
  for (const name of [id, ...aliases]) GRAMMARS[name] = { id, load };
}
add("typescript", typescript, ["ts", "mts", "cts"]);
add("tsx", tsx);
add("javascript", javascript, ["js", "mjs", "cjs"]);
add("jsx", jsx);
add("json", json);
add("jsonc", jsonc, ["json5"]);
add("shellscript", shell, ["bash", "sh", "shell", "zsh"]);
add("python", python, ["py"]);
add("diff", diff, ["patch"]);
add("yaml", yaml, ["yml"]);
add("markdown", markdown, ["md"]);
add("css", css);
add("html", html);
add("sql", sql);
add("go", go, ["golang"]);
add("rust", rust, ["rs"]);
add("toml", toml);
add("dockerfile", dockerfile, ["docker"]);
add("java", java);
add("c", c, ["h"]);
add("cpp", cpp, ["c++", "cc", "hpp"]);
add("csharp", csharp, ["cs", "c#"]);
add("ruby", ruby, ["rb"]);
add("php", php);
add("swift", swift);
add("kotlin", kotlin, ["kt", "kts"]);
add("xml", xml, ["svg"]);
add("graphql", graphql, ["gql"]);
add("make", make, ["makefile"]);
add("scss", scss);
add("ini", ini, ["properties"]);
add("lua", lua);
add("shellsession", shellsession, ["console"]);
add("powershell", powershell, ["ps1"]);
add("hcl", hcl, ["terraform"]);
add("proto", proto);
add("dotenv", dotenv, ["env"]);

/** An own entry of a lookup table: names come from fences and file paths the model wrote, so
 *  `constructor` or `__proto__` must not reach `Object.prototype`. */
function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** The grammar id for a fence language, or undefined when we don't highlight it. */
export function resolveLang(lang: string): string | undefined {
  return own(GRAMMARS, lang.toLowerCase())?.id;
}

const THEMES = { light: "github-light", dark: "github-dark" } as const;

// One highlighter for the app, created on first use. The JavaScript regex engine avoids
// shipping Oniguruma's WASM.
let highlighter: Promise<HighlighterCore> | undefined;
function getHighlighter() {
  // A failed chunk load shouldn't poison every later attempt, so the reset is attached once, with the promise.
  highlighter ??= Promise.all([import("shiki/core"), import("shiki/engine/javascript")])
    .then(([{ createHighlighterCore }, { createJavaScriptRegexEngine }]) =>
      createHighlighterCore({
        themes: [import("shiki/themes/github-light.mjs"), import("shiki/themes/github-dark.mjs")],
        langs: [],
        engine: createJavaScriptRegexEngine(),
      }),
    )
    .catch((e) => {
      highlighter = undefined;
      throw e;
    });
  return highlighter;
}

const loading = new Map<string, Promise<void>>();
function loadGrammar(h: HighlighterCore, id: string, load: GrammarLoader) {
  let p = loading.get(id);
  if (!p) {
    p = load().then((m) => h.loadLanguage(m.default));
    loading.set(id, p);
    p.catch(() => loading.delete(id));
  }
  return p;
}

/** Highlighted HTML for `code`, or null when the language isn't one we highlight. */
export async function highlight(code: string, lang: string): Promise<string | null> {
  const grammar = own(GRAMMARS, lang.toLowerCase());
  if (!grammar) return null;
  const h = await getHighlighter();
  await loadGrammar(h, grammar.id, grammar.load);
  return h.codeToHtml(code, { lang: grammar.id, themes: THEMES });
}

// File extensions (and whole file names) that differ from a fence name; anything else is looked up
// as a fence name, so `.ts`, `.py`, `.rs`, `.yml` … resolve through the aliases above.
const EXTENSIONS: Record<string, string> = {
  htm: "html",
  tf: "hcl",
  tfvars: "hcl",
  mk: "make",
  gradle: "kotlin",
  bashrc: "shellscript",
  zshrc: "shellscript",
};
const FILE_NAMES: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "make",
  gnumakefile: "make",
};

/** The grammar id for a file path, by its extension or name; undefined renders plain. */
export function langForPath(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (!name) return undefined;
  const byName = own(FILE_NAMES, name);
  if (byName) return byName;
  if (name === ".env" || name.startsWith(".env.")) return "dotenv";
  const dot = name.lastIndexOf(".");
  if (dot === -1) return undefined;
  const ext = name.slice(dot + 1);
  return resolveLang(own(EXTENSIONS, ext) ?? ext);
}

/** Files longer than this stay plain: highlighting them costs more than it gives (spec §9.2). */
export const MAX_HIGHLIGHT_LINES = 2000;

/** One coloured run of a highlighted line: inline styles carry both themes (`--shiki-dark`). */
export type HighlightToken = { content: string; style?: Record<string, string> };

/** Tokens per line for a file's text, or null when its path has no grammar or it runs past
 *  `MAX_HIGHLIGHT_LINES` lines. Lines are split as `code.split("\n")` splits them. */
export async function highlightFile(
  code: string,
  path: string,
): Promise<HighlightToken[][] | null> {
  const id = langForPath(path);
  if (!id) return null;
  // A trailing newline ends the last line rather than starting another.
  const body = code.endsWith("\n") ? code.slice(0, -1) : code;
  let lines = 1;
  for (let i = body.indexOf("\n"); i !== -1; i = body.indexOf("\n", i + 1))
    if (++lines > MAX_HIGHLIGHT_LINES) return null;
  const grammar = own(GRAMMARS, id);
  if (!grammar) return null;
  const h = await getHighlighter();
  await loadGrammar(h, grammar.id, grammar.load);
  return h
    .codeToTokens(code, { lang: grammar.id, themes: THEMES })
    .tokens.map((line) =>
      line.map((t) =>
        t.htmlStyle ? { content: t.content, style: t.htmlStyle } : { content: t.content },
      ),
    );
}
