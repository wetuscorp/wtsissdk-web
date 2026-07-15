import { describe, expect, it } from "vitest";

import { normalizePathname, validateEvent, validateOptions } from "../src/validation";

describe("validation", () => {
  it("keeps pathname collection free of query and fragment data", () => {
    expect(normalizePathname("pricing")).toBe("/pricing");
    expect(() => normalizePathname("/pricing?member=true")).toThrow(/query or fragment/);
    expect(() => normalizePathname("/pricing#plans")).toThrow(/query or fragment/);
  });

  it("accepts localhost development collectors but requires HTTPS elsewhere", () => {
    expect(
      validateOptions({ sourceKey: "web_source_key", collectorOrigin: "http://localhost:4021" }),
    ).toMatchObject({ collectorOrigin: "http://localhost:4021", consent: "pending" });
    expect(() =>
      validateOptions({ sourceKey: "web_source_key", collectorOrigin: "http://collector.test" }),
    ).toThrow(/HTTPS/);
  });

  it("enforces scalar properties and decimal revenue", () => {
    expect(() =>
      validateEvent(
        "purchase",
        { plan: "enterprise", seats: 12, annual: true },
        {
          amount: "1490.50",
          currency: "TRY",
        },
      ),
    ).not.toThrow();
    expect(() => validateEvent("purchase", { amount: Number.NaN })).toThrow(/finite/);
    expect(() => validateEvent("purchase", {}, { amount: "1490,50", currency: "try" })).toThrow(
      /ISO-4217/,
    );
  });
});
