import { expect, test } from "@playwright/test";
import { resolve } from "node:path";

test("cleans only legacy namespaces and creates no data state before consent", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.route("https://sdk.test/", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>SDK test</title>" }),
  );
  await page.goto("https://sdk.test/");
  requests.length = 0;
  await page.addScriptTag({ path: resolve("dist/wts-web.iife.min.js") });

  const result = await page.evaluate(async () => {
    const storageCalls = {
      indexedDbOpen: 0,
      indexedDbDelete: 0,
      consentReads: 0,
      localWrites: 0,
      sessionReads: 0,
      sessionWrites: 0,
      sessionDeletes: 0,
    };
    const originalOpen = indexedDB.open.bind(indexedDB);
    const originalDeleteDatabase = indexedDB.deleteDatabase.bind(indexedDB);
    Object.defineProperty(indexedDB, "open", {
      configurable: true,
      value(...args: Parameters<IDBFactory["open"]>) {
        storageCalls.indexedDbOpen += 1;
        return originalOpen(...args);
      },
    });
    Object.defineProperty(indexedDB, "deleteDatabase", {
      configurable: true,
      value(...args: Parameters<IDBFactory["deleteDatabase"]>) {
        storageCalls.indexedDbDelete += 1;
        return originalDeleteDatabase(...args);
      },
    });
    const originalGetItem = Storage.prototype.getItem;
    const originalSetItem = Storage.prototype.setItem;
    const originalRemoveItem = Storage.prototype.removeItem;
    Storage.prototype.getItem = function (key) {
      if (this === localStorage) storageCalls.consentReads += 1;
      if (this === sessionStorage) storageCalls.sessionReads += 1;
      return originalGetItem.call(this, key);
    };
    Storage.prototype.setItem = function (key, value) {
      if (this === localStorage) storageCalls.localWrites += 1;
      if (this === sessionStorage) storageCalls.sessionWrites += 1;
      return originalSetItem.call(this, key, value);
    };
    Storage.prototype.removeItem = function (key) {
      if (this === sessionStorage) storageCalls.sessionDeletes += 1;
      return originalRemoveItem.call(this, key);
    };
    const client = window.WtsWeb.createWtsClient({ sourceKey: "web_test_source" });
    const pageResult = await client.page("Pending page");
    client.destroy();
    return { pageResult, storageCalls };
  });

  expect(result.pageResult).toEqual({ accepted: false, reason: "consent_pending" });
  expect(result.storageCalls).toEqual({
    indexedDbOpen: 0,
    indexedDbDelete: 1,
    consentReads: 1,
    localWrites: 0,
    sessionReads: 0,
    sessionWrites: 0,
    sessionDeletes: 2,
  });
  expect(requests).toEqual([]);
});
