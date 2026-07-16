import { createWtsClient } from "@wetusco/wts-web-sdk";

const client = createWtsClient({ sourceKey: "replace_with_source_key" });
document.querySelector("#grant")?.addEventListener("click", async () => {
  await client.setConsent("granted");
  await client.page("Vite example");
});
document
  .querySelector("#purchase")
  ?.addEventListener("click", () =>
    client.track("purchase", { plan: "enterprise" }, { amount: "1490.50", currency: "TRY" }),
  );
