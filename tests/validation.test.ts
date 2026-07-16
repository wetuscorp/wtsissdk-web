import { describe, expect, it } from "vitest";

import {
  normalizePathname,
  validateEvent,
  validateExternalUserId,
  validateOptions,
  validateReportedAttribution,
  validateUserAttributes,
  validateUserUpdate,
} from "../src/validation";

describe("validation", () => {
  it("keeps pathname collection free of query and fragment data", () => {
    expect(normalizePathname("pricing")).toBe("/pricing");
    expect(() => normalizePathname("/pricing?member=true")).toThrow(/query or fragment/);
    expect(() => normalizePathname("/pricing#plans")).toThrow(/query or fragment/);
  });

  it("validates identity and atomic profile update operations", () => {
    expect(() => validateExternalUserId("customer_1842")).not.toThrow();
    expect(() =>
      validateUserUpdate({
        set: { plan: "business" },
        setOnce: { signup_channel: "partner" },
        increment: { lifetime_orders: 1 },
      }),
    ).not.toThrow();
    expect(() => validateUserUpdate({ set: { plan: "business" }, unset: ["plan"] })).toThrow(
      /only once/,
    );
    expect(() =>
      validateReportedAttribution({
        source: "newsletter",
        medium: "email",
        campaign: "summer_2026",
      }),
    ).not.toThrow();
    expect(() =>
      validateUserAttributes({ created_at: new Date("2026-07-16T10:00:00.000Z") }),
    ).not.toThrow();
    expect(() => validateUserAttributes({ created_at: new Date("invalid") })).toThrow(/valid Date/);
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
