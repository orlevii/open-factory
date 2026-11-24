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
