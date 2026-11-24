import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { UntrustedCode, UntrustedProse, visibleControls } from "./untrusted-text";

test("visibleControls shows bidi, zero-width and control characters as tokens", () => {
  expect(visibleControls("a‮b")).toBe("a⟨U+202E⟩b");
  expect(visibleControls("a⁧b​c\u0007d")).toBe("a⟨U+2067⟩b⟨U+200B⟩c⟨U+0007⟩d");
  expect(visibleControls("\u001b[31m")).toBe("⟨ESC⟩[31m");
  expect(visibleControls("a\tb\nc")).toBe("a\tb\nc");
});

test.each([
  ["RLM", "\u200f", "⟨U+200F⟩"],
  ["LRM", "\u200e", "⟨U+200E⟩"],
  ["ALM", "\u061c", "⟨U+061C⟩"],
  ["soft hyphen", "\u00ad", "⟨U+00AD⟩"],
  ["invisible operator", "\u2062", "⟨U+2062⟩"],
  ["mongolian vowel separator", "\u180e", "⟨U+180E⟩"],
  ["C1 NEL", "\u0085", "⟨U+0085⟩"],
  ["C1 last", "\u009f", "⟨U+009F⟩"],
])("visibleControls tokenises %s", (_name, ch, token) => {
  expect(visibleControls(`a${ch}b`)).toBe(`a${token}b`);
});

test("visibleControls reads CRLF as a line break and still shows a lone CR as a token", () => {
  expect(visibleControls("one\r\ntwo\r\n")).toBe("one\ntwo\n");
  expect(visibleControls("a\rb")).toBe("a⟨U+000D⟩b");
  expect(visibleControls("a\r\r\nb")).toBe("a⟨U+000D⟩\nb");
});

test("UntrustedCode clamps at 40 lines from the top and Show all reveals the rest", async () => {
  const text = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
  const { container } = render(<UntrustedCode text={text} fromTop />);
  expect(container.textContent).toContain("line 40");
  expect(container.textContent).not.toContain("line 41");
  await userEvent.click(screen.getByRole("button", { name: "Show all · 100 lines" }));
  expect(container.textContent).toContain("line 100");
  expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
});

test("UntrustedCode renders a URL as plain text and marks invisible characters", () => {
  const { container } = render(<UntrustedCode text={"see https://evil.example‮"} />);
  expect(container.querySelector("a")).toBeNull();
  expect(container.textContent).toContain("https://evil.example⟨U+202E⟩");
});

test("UntrustedProse shows control tokens and no markdown or links", () => {
  const { container } = render(<UntrustedProse text={"[x](https://e.example) ‮"} />);
  expect(container.querySelector("a")).toBeNull();
  expect(container.textContent).toBe("[x](https://e.example) ⟨U+202E⟩");
});

test("UntrustedCode shows CRLF file text without a token at every line end", () => {
  const { container } = render(<UntrustedCode text={"first\r\nsecond\r\n"} />);
  expect(container.textContent).not.toContain("U+000D");
  expect(container.querySelector("pre")?.textContent).toBe("first\nsecond\n");
});

test.each([
  ["a tag character", "a\u{E0041}b", "a⟨U+E0041⟩b"],
  ["a variation selector", "a\uFE0Fb", "a⟨U+FE0F⟩b"],
  ["a line separator", "a\u2028b", "a⟨U+2028⟩b"],
  ["a paragraph separator", "a\u2029b", "a⟨U+2029⟩b"],
  ["a Hangul choseong filler", "a\u115Fb", "a⟨U+115F⟩b"],
  ["a Hangul jungseong filler", "a\u1160b", "a⟨U+1160⟩b"],
  ["a Hangul filler", "a\u3164b", "a⟨U+3164⟩b"],
])("visibleControls shows %s as a token", (_, text, shown) => {
  expect(visibleControls(text)).toBe(shown);
});
