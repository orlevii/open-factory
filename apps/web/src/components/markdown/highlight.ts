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
add("shellscript", shell, ["bash", "sh", "shell", "zsh", "console"]);
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

/** The grammar id for a fence language, or undefined when we don't highlight it. */
export function resolveLang(lang: string): string | undefined {
  return GRAMMARS[lang.toLowerCase()]?.id;
}

const THEMES = { light: "github-light", dark: "github-dark" } as const;

// One highlighter for the app, created on first use. The JavaScript regex engine avoids
// shipping Oniguruma's WASM.
let highlighter: Promise<HighlighterCore> | undefined;
function getHighlighter() {
  highlighter ??= Promise.all([import("shiki/core"), import("shiki/engine/javascript")]).then(
    ([{ createHighlighterCore }, { createJavaScriptRegexEngine }]) =>
      createHighlighterCore({
        themes: [import("shiki/themes/github-light.mjs"), import("shiki/themes/github-dark.mjs")],
        langs: [],
        engine: createJavaScriptRegexEngine(),
      }),
  );
  // A failed chunk load shouldn't poison every later attempt.
  highlighter.catch(() => {
    highlighter = undefined;
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
  const grammar = GRAMMARS[lang.toLowerCase()];
  if (!grammar) return null;
  const h = await getHighlighter();
  await loadGrammar(h, grammar.id, grammar.load);
  return h.codeToHtml(code, { lang: grammar.id, themes: THEMES });
}
