import { expect, test } from "@playwright/test";
import { resolve } from "node:path";

test("exposes the versioned IIFE without network or storage before consent", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.setContent("<!doctype html><title>SDK test</title>");
  await page.addScriptTag({ path: resolve("dist/wts-web.iife.min.js") });

  const result = await page.evaluate(async () => {
    const storageReads = { indexedDB: 0, localStorage: 0, sessionStorage: 0 };
    for (const key of Object.keys(storageReads) as Array<keyof typeof storageReads>) {
      Object.defineProperty(window, key, {
        configurable: true,
        get() {
          storageReads[key] += 1;
          return undefined;
        },
      });
    }
    const client = window.WtsWeb.createWtsClient({ sourceKey: "web_test_source" });
    const pageResult = await client.page("Pending page");
    client.destroy();
    return { pageResult, storageReads };
  });

  expect(result.pageResult).toEqual({ accepted: false, reason: "consent_pending" });
  expect(result.storageReads).toEqual({ indexedDB: 0, localStorage: 0, sessionStorage: 0 });
  expect(requests).toEqual([]);
});
