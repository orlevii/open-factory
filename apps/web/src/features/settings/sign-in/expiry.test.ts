import { describe, expect, it } from "vitest";
import { expiryState } from "./expiry";

const now = new Date("2027-11-03T12:00:00Z");

describe("expiryState", () => {
  it("more than 14 days is month precision, muted", () =>
    expect(expiryState("2028-01-15T00:00:00Z", now, "en-GB", "UTC")).toEqual({
      tone: "muted",
      text: "Expires Jan 2028",
    }));
  it("within 14 days counts calendar days, warning", () =>
    expect(expiryState("2027-11-12T00:00:00Z", now, "en-GB", "UTC")).toEqual({
      tone: "warning",
      text: "Expires in 9 days",
      needsSignIn: true,
    }));
  it("tomorrow and today", () => {
    expect(expiryState("2027-11-04T08:00:00Z", now, "en-GB", "UTC")).toMatchObject({
      text: "Expires tomorrow",
    });
    expect(expiryState("2027-11-03T20:00:00Z", now, "en-GB", "UTC")).toMatchObject({
      text: "Expires today",
    });
  });
  it("tone follows the exact 14-day comparison, so a warning never says 15 days", () => {
    const edge = new Date(now.getTime() + 14 * 86400_000).toISOString();
    expect(expiryState(edge, now, "en-GB", "America/Los_Angeles")).toMatchObject({
      tone: "warning",
    });
    expect(
      (expiryState(edge, now, "en-GB", "America/Los_Angeles") as { text: string }).text,
    ).not.toMatch(/15/);
  });
  it("past is crimson with the date", () =>
    expect(expiryState("2027-11-01T00:00:00Z", now, "en-GB", "UTC")).toEqual({
      tone: "crimson",
      text: "Expired 1 Nov 2027",
      needsSignIn: true,
    }));
  it("null is nothing", () => expect(expiryState(null, now)).toEqual({ tone: "none" }));
});
