import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import { RunPreview } from "./run-preview";

test("each run, and the viewer's time, stays on one line; the text reads as one sentence", () => {
  const { container } = render(
    <RunPreview
      preview={{
        lead: "Next runs:",
        runs: [{ at: "Mon 7 Dec 09:00", mine: "(08:00 your time)" }, { at: "Tue 8 Dec 09:00" }],
        zone: "Europe/Berlin",
      }}
    />,
  );
  const p = container.querySelector("p") as HTMLElement;
  expect(p.textContent).toBe(
    "Next runs: Mon 7 Dec 09:00 (08:00 your time) · Tue 8 Dec 09:00 Europe/Berlin",
  );
  const nowrap = [...p.querySelectorAll(".whitespace-nowrap")].map((s) => s.textContent);
  expect(nowrap).toEqual(["Mon 7 Dec 09:00", "(08:00 your time)", "Tue 8 Dec 09:00"]);
});
