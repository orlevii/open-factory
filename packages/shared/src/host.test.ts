import { expect, test } from "vitest";
import { isHostPathShape } from "./host.ts";

test.each([
  ["/a", true],
  ["/", true],
  ["~", true],
  ["~/code/web", true],
  ["~other/x", false],
  ["code/web", false],
  ["./x", false],
  ["", false],
  ["C:\\x", false],
])("isHostPathShape(%j) is %s", (p, ok) => expect(isHostPathShape(p)).toBe(ok));
