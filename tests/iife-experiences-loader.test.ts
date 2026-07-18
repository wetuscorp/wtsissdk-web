import { afterEach, describe, expect, it, vi } from "vitest";

import { loadExperienceRuntime } from "../src/experiences/loader.iife";

type ExperienceWindow = Window & {
  __wtsWebAssetBaseUrl?: string;
  __wtsWebAssetIntegrity?: { experiences?: string };
  __wtsWebExperiencesFactory?: { create: ReturnType<typeof vi.fn> };
  __wtsWebExperiencesLoadProof?: object;
  __wtsWebExperiencesFactoryProof?: object;
};

const experienceSri = `sha384-${"a".repeat(64)}`;

afterEach(() => {
  const host = window as ExperienceWindow;
  delete host.__wtsWebAssetBaseUrl;
  delete host.__wtsWebAssetIntegrity;
  delete host.__wtsWebExperiencesFactory;
  delete host.__wtsWebExperiencesLoadProof;
  delete host.__wtsWebExperiencesFactoryProof;
  vi.restoreAllMocks();
});

describe("IIFE Experiences loader", () => {
  it("fails closed without an exact companion SHA-384 pin", async () => {
    const host = window as ExperienceWindow;
    host.__wtsWebAssetBaseUrl = "https://cdn.example.test/releases/0.4.0-alpha.1/";
    const append = vi.spyOn(document.head, "append");

    await expect(loadExperienceRuntime({} as never)).rejects.toThrow(
      "EXPERIENCE_MODULE_UNAVAILABLE",
    );
    expect(append).not.toHaveBeenCalled();
  });

  it("does not trust a pre-existing unverified companion factory", async () => {
    const host = window as ExperienceWindow;
    host.__wtsWebAssetBaseUrl = "https://cdn.example.test/releases/0.4.0-alpha.1/";
    host.__wtsWebAssetIntegrity = { experiences: experienceSri };
    const unverifiedCreate = vi.fn();
    host.__wtsWebExperiencesFactory = { create: unverifiedCreate };
    const append = vi.spyOn(document.head, "append").mockImplementation((...nodes) => {
      const script = nodes[0] as HTMLScriptElement;
      // Simulates an unpinned companion that was evaluated before the primary
      // IIFE. It has no proof issued by this SRI-backed loader.
      script.onload?.(new Event("load"));
    });

    await expect(loadExperienceRuntime({} as never)).rejects.toThrow(
      "EXPERIENCE_MODULE_UNAVAILABLE",
    );
    expect(append).toHaveBeenCalledTimes(1);
    expect(unverifiedCreate).not.toHaveBeenCalled();
  });

  it("injects the matching companion with its exact SHA-384 SRI pin", async () => {
    const host = window as ExperienceWindow;
    host.__wtsWebAssetBaseUrl = "https://cdn.example.test/releases/0.4.0-alpha.1/";
    host.__wtsWebAssetIntegrity = { experiences: experienceSri };
    const runtime = { marker: "experience-runtime" };
    const create = vi.fn(() => runtime);
    const unverifiedCreate = vi.fn();
    host.__wtsWebExperiencesFactory = { create: unverifiedCreate };
    const append = vi.spyOn(document.head, "append").mockImplementation((...nodes) => {
      const script = nodes[0] as HTMLScriptElement;
      host.__wtsWebExperiencesFactory = { create };
      const loadProof = host.__wtsWebExperiencesLoadProof;
      if (!loadProof) throw new Error("Expected an SRI-backed Experiences load proof.");
      host.__wtsWebExperiencesFactoryProof = loadProof;
      script.onload?.(new Event("load"));
    });

    await expect(loadExperienceRuntime({ sourceKey: "web_test_source" } as never)).resolves.toBe(
      runtime,
    );

    const script = append.mock.calls[0]?.[0] as HTMLScriptElement;
    expect(script.src).toBe(
      "https://cdn.example.test/releases/0.4.0-alpha.1/wts-web-experiences.iife.min.js",
    );
    expect(script.integrity).toBe(experienceSri);
    expect(script.crossOrigin).toBe("anonymous");
    expect(script.referrerPolicy).toBe("no-referrer");
    expect(create).toHaveBeenCalledWith({ sourceKey: "web_test_source" });
    expect(unverifiedCreate).not.toHaveBeenCalled();
  });
});
