import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const FIXTURES_DIR = fileURLToPath(new URL("../fixtures/", import.meta.url));

export const fixtureNames = () =>
  readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.replace(/\.jsonl$/, ""));

export function readFixture(name: string): unknown[] {
  return readFileSync(`${FIXTURES_DIR}${name}.jsonl`, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}
