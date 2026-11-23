import { expect, test } from "vitest";
import { plainPreview } from "./preview.ts";

test.each([
  ["```ts\nconst a = 1\n```\nDone", "const a = 1 Done"],
  ["**bold** and _it_ and `code`", "bold and it and code"],
  ["[the PR](https://x/y) is up", "the PR is up"],
  ["# Title\n- one\n- two", "Title one two"],
  ["1. first\n2. second", "first second"],
  ["snake_case_name stays", "snake_case_name stays"],
  ["  lots   of\n\n space  ", "lots of space"],
])("plainPreview(%j)", (md, out) => expect(plainPreview(md)).toBe(out));
