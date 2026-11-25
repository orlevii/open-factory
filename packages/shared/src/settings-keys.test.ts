import { describe, expect, test } from "vitest";
import { RESERVED_SETTINGS_KEYS, reservedKeysIn } from "./settings-keys.ts";

/** The spec §7.10 keys, as written in the spec. Each must be reported when a settings file sets it. */
const SPEC_KEYS = [
  "permissions.defaultMode",
  "permissions.additionalDirectories",
  "claudeMdExcludes",
  "hooks",
  "statusLine",
  "fileSuggestion",
  "apiKeyHelper",
  "awsAuthRefresh",
  "awsCredentialExport",
  "gcpAuthRefresh",
  "otelHeadersHelper",
];

/** Builds `{ a: { b: value } }` for the dotted path `a.b`. */
const nest = (dotted: string): Record<string, unknown> =>
  dotted.split(".").reduceRight<unknown>((value, key) => ({ [key]: value }), true) as Record<
    string,
    unknown
  >;

test("RESERVED_SETTINGS_KEYS is exactly the spec §7.10 list", () => {
  expect([...RESERVED_SETTINGS_KEYS].sort()).toEqual([...SPEC_KEYS].sort());
});

describe("reservedKeysIn", () => {
  test.each(SPEC_KEYS)("reports %s when a settings file sets it", (key) => {
    expect(reservedKeysIn(nest(key))).toEqual([key]);
  });

  test("ignores a harmless sibling key", () => {
    expect(reservedKeysIn({ permissions: { allow: ["Bash(npm test)"] } })).toEqual([]);
  });

  test("reports every reserved key, sorted, and the factory env names", () => {
    expect(
      reservedKeysIn({
        hooks: {},
        permissions: { defaultMode: "x" },
        env: { OPEN_FACTORY_URL: "/x", FOO: "1" },
      }),
    ).toEqual(["env.OPEN_FACTORY_URL", "hooks", "permissions.defaultMode"]);
  });

  test("reports an env name from the factory list", () => {
    expect(reservedKeysIn({ env: { ANTHROPIC_API_KEY: "k", GH_TOKEN: "t" } })).toEqual([
      "env.ANTHROPIC_API_KEY",
    ]);
  });

  test("a settings value that isn't an object reports nothing", () => {
    expect(reservedKeysIn(null)).toEqual([]);
    expect(reservedKeysIn("hooks")).toEqual([]);
  });
});
