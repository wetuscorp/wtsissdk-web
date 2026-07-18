# @wetusco/wts-web-sdk

Consent-first browser measurement and deterministic wts.is link attribution. The SDK is dependency-free, safe to import during server rendering, and never collects DOM content, form values, URL queries, fragments, advertising identifiers, or fingerprints.

> `0.4.0-alpha.1` adds signed Experience-manifest verification, explicit
> profile consent for personalized Experiences, and a manual presentation
> lifecycle while retaining Web Protocol V3 analytics, identity, deterministic
> attribution, and SDK Test Session V1 behavior.

> **Version discipline:** Keep the npm package, versioned IIFE and its two
> companion artifacts on the same `0.4.0-alpha.1` release. SDK Test & Validate
> and Experiences deliberately fail closed when their matching companion is
> unavailable or cannot be verified.

## Requirements

- A Web App created in the wts.is dashboard
- The page origin included in that Web App's exact allowed-origin list
- Safari 15+ or the latest two major Chrome, Edge, and Firefox releases
- A consent-management decision supplied on every page load

Core analytics supports the browser matrix above. Experiences additionally
require WebCrypto Ed25519 verification. A browser without that capability
fails Experiences closed: no manifest content is used or rendered, while
analytics continues to work normally.

## npm installation

```bash
npm install @wetusco/wts-web-sdk@0.4.0-alpha.1
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
  src="https://cdn.jsdelivr.net/npm/@wetusco/wts-web-sdk@0.4.0-alpha.1/dist/wts-web.iife.min.js"
  integrity="<sha384-from-wts-web.iife.min.js.sri>"
  crossorigin="anonymous"
  data-wts-web-experiences-integrity="<sha384-from-wts-web-experiences.iife.min.js.sri>"
></script>
<script>
  const wts = window.WtsWeb.createWtsClient({
    sourceKey: "web_public_source_key",
    consent: "pending",
  });
</script>
```

The IIFE exports `window.WtsWeb`. Use the exact SHA-384 value supplied with
this release in `dist/wts-web.iife.min.js.sri`.
The SDK Test & Validate methods remain available on that client. When one is
called, the SDK loads the matching `wts-web-test-session.iife.min.js` companion
from the same versioned `dist/` directory. Experiences follows the same model:
when it is explicitly enabled, the SDK loads
`wts-web-experiences.iife.min.js`. Set
`data-wts-web-experiences-integrity` to the exact value in that companion's
`wts-web-experiences.iife.min.js.sri` file; the IIFE fails closed and does not
inject the companion if the pin is absent or malformed. The primary and
companion artifacts must come from the same immutable release directory and
their host must support anonymous CORS for browser SRI verification. Deploy all
three version-matched artifacts together so these opt-in capabilities remain
available without inflating the analytics entry bundle.

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

## Experiences

Experiences is disabled by default even after upgrading. Enable it explicitly,
provide action allowlists and pass a separate consent decision on every page
load:

```ts
const wts = createWtsClient({
  sourceKey: "web_public_source_key",
  consent: "pending",
  experiences: {
    enabled: true,
    renderMode: "automatic",
    manifestVerificationKeys: {
      current: "<base64-spki-der-ed25519-public-key>",
    },
    allowedInternalRoutes: ["/checkout", "/account"],
    allowedCallbackKeys: ["apply_offer"],
    allowedWebOrigins: ["https://www.example.com"],
    allowedDeepLinkHosts: ["links.example.com"],
  },
});

await wts.setConsent("granted");
await wts.setExperienceConsent("contextual");
await wts.page("Checkout");
```

Fetch the public verification-key ring through the authenticated workspace API:

```text
GET /api/v1/organizations/:organizationId/experiences/manifest-verification-keys
```

Each value is a base64 SPKI DER Ed25519 **public** key, indexed by `kid`. Pin
the returned public keys in your deployment configuration and retain an
overlap during rotation. Never derive, export, copy, or configure a private
signing key in a browser or application source tree. A missing matching key or
an invalid signature fails closed and no Experience is presented.

Use `personalized` only after an explicit profile-consent signal and an
`identify()` mutation has been accepted by the collector. This is a real
identity-binding gate: the SDK does not treat its anonymous browser identity
as a known profile. Call `identify()`, await `flush()`, then enable
personalized Experiences. `setProfileConsent` is an in-memory Experience
permission; it does not retroactively gate or change analytics and identity
methods. `pending` makes no Experience request. `denied` removes cached
manifest, assignment and unsent interaction data.

```ts
await wts.setConsent("granted");
await wts.setProfileConsent(true); // Call on every page load from your CMP/privacy flow.
await wts.identify("customer_1842");
await wts.flush(); // Personalized Experiences require a collector-accepted binding.
await wts.setExperienceConsent("personalized");
await wts.page("Checkout");
```

Automatic mode loads the accessible Shadow DOM renderer only when a campaign
is eligible. Manual mode does not create SDK UI. It offers only the next queued
candidate once through `onExperienceAvailable`, with an opaque handle that is
valid only for that presentation. `presentNextExperience()` is automatic-mode
only and returns `false` in manual mode. Use `onExperienceAction` for
allowlisted application callbacks. At most one experience is visible and the
local candidate queue is bounded to five. A session can admit at most two
overlay presentations (modal, slide-in, or bottom sheet), even if a user
dismisses one before it qualifies as an impression.

The automatic web renderer accepts only these semantic content tokens. They
are mapped to a closed SDK-owned colour vocabulary; token values are never
treated as CSS. An unknown future token safely falls back to the campaign's
`themePreset` until the SDK adds support for it.

| Content field     | Supported tokens                                       |
| ----------------- | ------------------------------------------------------ |
| `backgroundToken` | `surface`, `subtle`, `inverse`, `brand`                |
| `textToken`       | `primary`, `muted`, `inverse`                          |
| `accentToken`     | `primary`, `secondary`, `success`, `warning`, `danger` |

`CUSTOM_CALLBACK` has no SDK default action. Its target must be allowlisted
and an `onExperienceAction` handler must return `true` after the host action
actually completes. If no handler accepts it, the SDK keeps the Experience
open, does not record an action interaction, and exposes
`EXPERIENCE_CALLBACK_UNHANDLED` through `getExperienceDiagnostics()`.

An impression is recorded only after at least half of the experience remains
visible for one uninterrupted second. Interaction delivery uses the persistent
bounded queue, UUID idempotency and the same retry policy as product events.

```ts
const unsubscribe = wts.onExperienceAction(async ({ action }) => {
  if (action.type === "CUSTOM_CALLBACK" && action.target === "apply_offer") {
    await applyOffer();
    return true;
  }
  return false;
});

await wts.presentNextExperience();
await wts.dismissCurrentExperience();
console.log(wts.getExperienceDiagnostics());
unsubscribe();
```

For manual rendering, report only real lifecycle transitions. Repeating an
accepted transition returns `{ accepted: true, idempotent: true }`; the handle
does not expose campaign grants or the exposure identifier in the experience
payload. `onExperienceAvailable` may be `async`; an unhandled synchronous or
asynchronous renderer failure is contained and reported as
`EXPERIENCE_MANUAL_HANDLER_FAILED` in diagnostics instead of becoming an
unhandled promise rejection.

```ts
const unsubscribeManual = wts.onExperienceAvailable(async ({ experience, handle }) => {
  try {
    // Mount the host UI before acknowledging a successful render.
    showYourOwnModal(experience);
    await wts.acknowledgeExperienceRender(handle);

    // Report this only after the modal is at least visibly presented.
    await wts.acknowledgeExperienceImpression(handle);

    // Report only actions the user actually performed.
    await wts.reportExperienceAction(handle, "primary");
    await wts.dismissExperience(handle, { reason: "dismissed" });
  } catch {
    // A renderer failure is reported without treating it as an impression.
    await wts.dismissExperience(handle, { failureCode: "HOST_RENDER_FAILED" });
  }
});

unsubscribeManual();
```

The verified manifest expiry also applies to candidates already waiting in the
local queue. An expired candidate is never rendered. Calling `resetIdentity()`
clears queued Experience interactions before the SDK creates the next
anonymous identity, so an old browser user's interactions cannot be delivered
under the next user's identity.

For a draft Experience device test, copy
`wts.getExperienceDiagnostics().testDeviceToken` into the dashboard test
panel for the same Web App. The random token is scoped to this SDK instance;
it contains no user, browser, or profile identifier. Test impressions and
conversions are excluded from customer analytics and usage.

## SDK Test & Validate

SDK Test & Validate is a dashboard-issued, short-lived validation session. Its
bounded retry queue is isolated from production page views, events, identity,
attribution, and Experiences. Do not hardcode, log, or persist a pairing URL
or token outside the SDK.

The dashboard QR code uses this canonical form:

```text
https://<web-app-host>/_wts/test/pair?pairing=<dashboard-issued-token>
```

The Web SDK does not resolve or navigate normal application URLs. Your router
must recognize the pairing route, join it before normal routing, and retain its
own normal fallback behavior:

```ts
function isWtsTestPairing(rawUrl: string): boolean {
  const url = new URL(rawUrl, window.location.origin);
  return url.protocol === "https:" && url.pathname === "/_wts/test/pair";
}

async function onIncomingUrl(rawUrl: string) {
  if (isWtsTestPairing(rawUrl)) {
    const joined = await wts.joinTestSession(rawUrl);
    showSdkTestChecks(joined.checks);
    return;
  }

  // The host application owns ordinary routing and its web fallback.
  routeNormally(rawUrl);
}
```

Inspect the isolated session and run only the dashboard-selected plan:

```ts
const diagnostics = wts.getTestSessionDiagnostics();
const probes = await wts.runTestSessionProbes();

// This is a test-only manual decision; it never enters the normal Experiences
// renderer and does not generate production interaction events.
if (probes.experienceDecision?.outcome === "ready") {
  await presentTestExperiencePreview(probes.experienceDecision);
  await wts.reportTestSessionExperienceInteraction("impression");
}
```

Report `"action"` only after the corresponding real action in that manual
preview. It is accepted only after a ready isolated decision; normal Experience
lifecycle signals are never copied to test transport. Use
`probeTestSessionUrl(url)` for an event-free resolver check and
`leaveTestSession()` when the operator finishes. Expiry also clears the
session.

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

Allow the collector and, when automatic Experiences rendering is enabled, the
managed image CDN in your Content Security Policy:

```text
connect-src 'self' https://collect.wts.is;
img-src 'self' https://assets.wts.is;
```

## Framework notes

Importing the package in Next.js or another SSR runtime is safe. Browser APIs are accessed only when a client is created in a browser. See `examples/vite` and `examples/plain-html` for minimal integrations.

## Privacy and support

Read [SECURITY.md](SECURITY.md), [SUPPORT.md](SUPPORT.md), and the wts.is [Web SDK documentation](https://wts.is/en/resources/docs/sdk-web). Please do not report vulnerabilities in public issues.

## License

Apache License 2.0.
