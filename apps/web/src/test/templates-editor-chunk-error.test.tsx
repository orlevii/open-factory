import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";

// The editor's chunk fails to load (offline, a stale deploy's chunk hash).
vi.mock("@/features/templates/code-editor", () =>
  Promise.reject(new Error("Failed to fetch dynamically imported module")),
);
vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: () => ({ close() {}, status: () => "open", send: () => true }),
}));

/** A valid template opens on Configuration (I2 §12.5): these tests are about the file tabs, so open template.yaml. */
async function openTemplate(path = "/templates/lead") {
  const utils = renderApp(path, alice);
  await userEvent.click(await screen.findByRole("tab", { name: /template\.yaml/ }));
  return utils;
}

test("a failed editor chunk leaves the files editable as text, jumps included", async () => {
  mockApi({
    "POST /api/templates/lead/validate": () =>
      json({
        issues: [{ severity: "error", file: "settings.json", message: "JSON: bad", line: 2 }],
      }),
    "GET /api/templates/lead": () =>
      json({
        template: {
          name: "lead",
          path: "/h/of/templates/lead",
          issues: [{ severity: "error", file: "settings.json", message: "JSON: bad", line: 2 }],
          agents: [],
          avatar: { version: null, tooLarge: false },
          files: [
            { file: "template.yaml", content: "name: lead\n", hash: "h1" },
            { file: "AGENTS.md", content: "# Lead\n", hash: "h2" },
            { file: "settings.json", content: '{\n  "a": 1\n}\n', hash: "h3" },
            { file: "mcp.json", content: null, hash: null },
          ],
        },
      }),
  });
  await openTemplate();
  // The stand-in is named by the tab's label, as the editor would be.
  const el = await waitFor(() => {
    const t = screen.getByRole("textbox", { name: "template.yaml" });
    expect(t).toHaveAttribute("aria-labelledby", "tab-label-template.yaml");
    return t as HTMLTextAreaElement;
  });
  await userEvent.type(el, "x");
  expect(el).toHaveValue("name: lead\nx");
  expect(screen.getByRole("tab", { name: /template\.yaml.*\(unsaved\)/ })).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: /settings\.json.*JSON: bad/ }));
  const settings = await waitFor(() => {
    const t = screen.getByRole("textbox", { name: "settings.json" }) as HTMLTextAreaElement;
    expect(t).toHaveFocus();
    return t;
  });
  expect(settings.selectionStart).toBe(settings.value.indexOf("\n") + 1);
});
