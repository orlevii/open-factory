import { useSyncExternalStore } from "react";

/** The user's choice. "system" follows the OS appearance and keeps following it live. */
export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

/** Per-browser storage key. index.html reads the same key before first paint; keep them in sync. */
export const THEME_STORAGE_KEY = "of-theme";

/** Browser chrome colour per theme: the steel and graphite grounds in styles.css. */
const THEME_COLOR: Record<ResolvedTheme, string> = { light: "#F2F4F5", dark: "#15171A" };

const DARK_QUERY = "(prefers-color-scheme: dark)";
const listeners = new Set<() => void>();

function isPreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

/** Storage can throw (private windows, blocked site data); the theme then falls back to "system". */
export function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isPreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches;
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference === "system") return systemPrefersDark() ? "dark" : "light";
  return preference;
}

/** Writes the resolved theme to <html data-theme>, which every token and `dark:` variant keys off. */
export function applyTheme(preference: ThemePreference = readPreference()) {
  const resolved = resolveTheme(preference);
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.content = THEME_COLOR[resolved];
  }
}

export function setPreference(preference: ThemePreference) {
  try {
    if (preference === "system") localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Not persisted, but still applied for this page.
  }
  applyTheme(preference);
  for (const notify of listeners) notify();
}

function subscribe(notify: () => void) {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
}

/** The current preference, for the theme switch. */
export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribe, readPreference, () => "system" as const);
}

/** Call once at startup: applies the stored choice and, while it is "system", follows the OS
 *  appearance live (the inline script in index.html has already set the first paint). */
export function initTheme() {
  applyTheme();
  if (typeof window.matchMedia !== "function") return;
  // Another tab changing the theme updates this one too.
  window.addEventListener("storage", (e) => {
    if (e.key !== THEME_STORAGE_KEY) return;
    applyTheme();
    for (const notify of listeners) notify();
  });
  if (typeof window.matchMedia !== "function") return;
  window.matchMedia(DARK_QUERY).addEventListener("change", () => {
    if (readPreference() === "system") applyTheme("system");
  });
}
