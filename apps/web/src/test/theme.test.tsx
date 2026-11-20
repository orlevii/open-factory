import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { applyTheme, readPreference, setPreference, THEME_STORAGE_KEY } from "@/lib/theme";
import { alice, renderApp } from "@/test/render-app";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: () => ({ close() {}, status: () => "open", send: () => true }),
}));

const realMatchMedia = window.matchMedia;
function osPrefersDark(dark: boolean) {
  window.matchMedia = ((query: string) => ({
    ...realMatchMedia(query),
    matches: query === "(prefers-color-scheme: dark)" ? dark : false,
  })) as typeof window.matchMedia;
}

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});
afterEach(() => {
  window.matchMedia = realMatchMedia;
});

test("with no choice stored, the theme follows the OS", () => {
  osPrefersDark(true);
  applyTheme();
  expect(readPreference()).toBe("system");
  expect(document.documentElement.dataset.theme).toBe("dark");
  osPrefersDark(false);
  applyTheme();
  expect(document.documentElement.dataset.theme).toBe("light");
});

test("an explicit choice overrides the OS and is remembered; System clears it", () => {
  osPrefersDark(false);
  setPreference("dark");
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  setPreference("system");
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
});

test("an unknown stored value falls back to System", () => {
  localStorage.setItem(THEME_STORAGE_KEY, "sepia");
  expect(readPreference()).toBe("system");
});

test("the user menu switches the theme", async () => {
  osPrefersDark(false);
  renderApp("/", alice);
  await screen.findByRole("heading", { level: 1, name: "Home" });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /Alice/ }));
  expect(screen.getByRole("menuitemradio", { name: "System" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await user.click(screen.getByRole("menuitemradio", { name: "Dark" }));
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
});
