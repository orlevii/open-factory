import { expect, test } from "vitest";
import { formatBytes, formatTokens } from "./format";

test("tokens", () => {
  expect(formatTokens(27545)).toBe("27.5k");
  expect(formatTokens(15259)).toBe("15.3k");
  expect(formatTokens(129052)).toBe("129k");
  expect(formatTokens(950)).toBe("950");
});
test("bytes", () => {
  expect(formatBytes(1_200_000)).toBe("1.2 MB");
  expect(formatBytes(70_000)).toBe("70 KB");
});
