# @wetusco/wts-web-sdk

Consent-first browser measurement and deterministic wts.is link attribution. The SDK is dependency-free, safe to import during server rendering, and never collects DOM content, form values, URL queries, fragments, advertising identifiers, or fingerprints.

> `0.2.0-alpha.1` adds consent-gated identity through Web Protocol V3 while retaining the existing page, event, and deterministic attribution behavior.

## Requirements

- A Web App created in the wts.is dashboard
- The page origin included in that Web App's exact allowed-origin list
- Safari 15+ or the latest two major Chrome, Edge, and Firefox releases
- A consent-management decision supplied on every page load

## npm installation

```bash
npm install @wetusco/wts-web-sdk@next
```

```ts
import { createWtsClient } from "@wetusco/wts-web-sdk";

const wts = createWtsClient({
  sourceKey: "web_public_source_key",
  consent: "pending",
  autoTrackPageViews: false,
});

// Call from your CMP callback. Pending sends nothing and opens no storage.
await wts.setConsent("granted");
await wts.page("Pricing");

await wts.track(
  "purchase",
  { plan: "enterprise", member: true },
  { amount: "1490.50", currency: "TRY" },
);
```

Custom events must be registered in the Web App before they can be accepted. Revenue is a decimal string and always requires a three-letter ISO-4217 currency.

## Script installation

Use a versioned artifact and the SRI value shipped next to it. Do not use an unversioned `latest` script in production.

```html
<script
  src="https://cdn.jsdelivr.net/npm/@wetusco/wts-web-sdk@0.2.0-alpha.1/dist/wts-web.iife.min.js"
  integrity="sha384-ahc9V9IOmrRpKErCHoXwXF8o78RvGqtJgDgHO2UEPjxqsj8RzvVuQugsK5IO4brh"
  crossorigin="anonymous"
></script>
<script>
  const wts = window.WtsWeb.createWtsClient({
    sourceKey: "web_public_source_key",
    consent: "pending",
  });
</script>
```

The IIFE exports `window.WtsWeb`. The release workflow records the exact SHA-384 value in `dist/wts-web.iife.min.js.sri`.

## Consent behavior

- `pending` is the default. No network request, identity, storage, or queue is created.
- `granted` opens the first-party IndexedDB queue and starts delivery.
- `denied` clears all SDK storage and stops delivery.
- The SDK does not persist the consent decision. Your CMP must call `setConsent` on each page load.

Calls to `page` and `track` while pending or denied return an explicit no-op result. They are never retained in memory for later delivery.

## User identity and reported attribution

Identity operations use the same consent decision and are persisted ahead of product events. Use a stable, opaque internal customer ID rather than an email address. The ID is case-sensitive and is never trimmed or normalized by the SDK.

```ts
await wts.identify("customer_1842", {
  email: "user@example.com",
  plan: "enterprise",
  created_at: new Date("2026-07-16T10:00:00.000Z"),
});

await wts.updateUser({
  set: { plan: "business" },
  setOnce: { signup_channel: "partner" },
  increment: { lifetime_orders: 1 },
});

await wts.setReportedAttribution({
  source: "newsletter",
  medium: "email",
  campaign: "summer_2026",
});

await wts.resetIdentity(); // call on logout
```

`resetIdentity()` closes the current profile binding and rotates the anonymous and session identities. Setting consent to `denied` clears all browser SDK storage and stops collection.

The anonymous identity is first-party and persistent. The session identity and bootstrap idempotency key live in `sessionStorage`, so full-page navigations in the same browser session do not inflate session counts.

## Page tracking

Explicit page tracking is the default and recommended mode:

```ts
await wts.page("Account overview");
```

For client-side routers, set `autoTrackPageViews: true`. The SDK observes the initial pathname plus `pushState`, `replaceState`, and `popstate`, deduplicates repeated pathnames, and restores all listeners in `destroy()`. It only sends normalized pathname, optional page name, and referrer hostname.

## Link attribution

When a wts.is link is assigned to the same Web App, the redirect adds a short-lived signed `_wts` token. The SDK removes it from the address bar, keeps it only in memory until consent, and redeems it for a seven-day attribution context. The raw token is not stored with events.

## Queue and lifecycle

- Persistent first-party IndexedDB FIFO; bounded memory fallback when unavailable
- Maximum 100 events or 1 MiB
- Maximum 50 events or 64 KiB per request
- UUID idempotency, exponential retry with jitter, multi-tab delivery lock
- `pagehide` and hidden-page delivery with `fetch(..., { keepalive: true })`

```ts
await wts.flush(); // optional manual delivery
await wts.reset(); // clears identity, session, queue, and attribution
wts.destroy(); // removes timers and SPA/lifecycle listeners
```

## CSP

Allow the collector in your Content Security Policy:

```text
connect-src 'self' https://collect.wts.is
```

## Framework notes

Importing the package in Next.js or another SSR runtime is safe. Browser APIs are accessed only when a client is created in a browser. See `examples/vite` and `examples/plain-html` for minimal integrations.

## Privacy and support

Read [SECURITY.md](SECURITY.md), [SUPPORT.md](SUPPORT.md), and the wts.is [Web SDK documentation](https://wts.is/en/resources/docs/sdk-web). Please do not report vulnerabilities in public issues.

## License

Apache License 2.0.
