import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { DependencyEditor, dependsSummary } from "./dependency-editor";

test("dependsSummary names one, two, or two and the rest", () => {
  expect(dependsSummary([])).toBe("");
  expect(dependsSummary(["T-41"])).toBe("Depends on T-41.");
  expect(dependsSummary(["T-41", "T-52"])).toBe("Depends on T-41 and T-52.");
  expect(dependsSummary(["T-1", "T-2", "T-3", "T-4", "T-5"])).toBe(
    "Depends on T-1, T-2 and 3 more.",
  );
});

const props = { value: "T-41", onChange: () => {}, onBlur: () => {} };

test("the summary is the help, with no list", () => {
  const { container } = render(<DependencyEditor {...props} resolvedKeys={["T-41"]} />);
  expect(container.querySelector(".field-note")?.textContent).toContain("Depends on T-41.");
  expect(screen.queryByRole("list")).toBeNull();
});

test("an error replaces the help", () => {
  const { container } = render(
    <DependencyEditor {...props} resolvedKeys={["T-41"]} error="No task T-41." />,
  );
  expect(container.querySelector("[data-shown]")?.textContent).toBe("No task T-41.");
  expect(screen.getByRole("textbox")).toHaveAttribute("aria-invalid", "true");
});
