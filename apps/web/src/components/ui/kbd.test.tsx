import { render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Kbd } from "./kbd";

afterEach(() => vi.restoreAllMocks());

test("renders each key in its own kbd element", () => {
  render(<Kbd keys={["g", "i"]} />);
  expect(screen.getByText("g").tagName).toBe("KBD");
  expect(screen.getByText("i").tagName).toBe("KBD");
});

test("Mod is ⌘ on a Mac and Ctrl elsewhere", () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  const mac = render(<Kbd keys={["Mod", "K"]} />);
  expect(screen.getByText("⌘")).toBeInTheDocument();
  mac.unmount();
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
  render(<Kbd keys={["Mod", "K"]} />);
  expect(screen.getByText("Ctrl")).toBeInTheDocument();
});

test("platform comes from userAgentData when the browser has it", () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
  Object.defineProperty(navigator, "userAgentData", { value: { platform: "macOS" }, configurable: true });
  try {
    render(<Kbd keys={["Mod"]} />);
    expect(screen.getByText("⌘")).toBeInTheDocument();
  } finally {
    Reflect.deleteProperty(navigator, "userAgentData");
  }
});

test("a non-Mac userAgentData wins over a Mac navigator.platform", () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  Object.defineProperty(navigator, "userAgentData", { value: { platform: "Windows" }, configurable: true });
  try {
    render(<Kbd keys={["Mod"]} />);
    expect(screen.getByText("Ctrl")).toBeInTheDocument();
  } finally {
    Reflect.deleteProperty(navigator, "userAgentData");
  }
});

test("an empty userAgentData platform falls back to navigator.platform", () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  Object.defineProperty(navigator, "userAgentData", { value: { platform: "" }, configurable: true });
  try {
    render(<Kbd keys={["Mod"]} />);
    expect(screen.getByText("⌘")).toBeInTheDocument();
  } finally {
    Reflect.deleteProperty(navigator, "userAgentData");
  }
});
