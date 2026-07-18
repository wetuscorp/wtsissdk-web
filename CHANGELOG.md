# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and Semantic Versioning.

> The `0.4.0-alpha.1` source line below is not an npm publication claim.
> Consume SDK Test & Validate only from its matching published web package
> release.

## 0.4.0-alpha.1

- Require a host-pinned Ed25519 public-key ring to verify Experience manifests
  before any manifest payload is parsed or used.
- Added explicit in-memory profile consent for personalized Experiences without
  changing existing analytics or identity consent behavior.
- Hardened HTTPS deep-link actions to exact hostname allowlists and reject
  HTTPS scheme-only authorization.
- Defined the manual presentation contract with opaque handles, idempotent
  lifecycle acknowledgements, queue-head-only offers, and cooldown-safe next
  offers after dismissal or render failure.
- Cancel delayed automatic rendering when consent changes or the client is
  destroyed.

## 0.3.0-alpha.1

- Added explicitly opt-in wts.is Experiences with contextual and personalized consent.
- Added contextual manifest evaluation and personalized decision delivery.
- Added automatic Shadow DOM rendering and manual presentation mode.
- Added safe route, deep-link, web-origin and callback allowlists.
- Added visibility-qualified impressions, a bounded candidate queue and session safety caps.
- Added durable idempotent interaction delivery with retry and consent cleanup.
- Kept the renderer in a dynamic ESM chunk; the package remains below the 15 KiB gzip budget.
- Added opt-in SDK Test Session V1 pairing, diagnostics, isolated probes, and
  explicit manual test Experience impression/action reporting.

## 0.2.0-alpha.1

- Added consent-gated `identify`, `updateUser`, `setReportedAttribution`, and `resetIdentity`.
- Added a durable identity mutation queue that flushes before product events.
- Added Web Protocol V3 collector support while retaining V2 server compatibility.
- Preserved opaque external user IDs and added native `Date` attribute support.
- Fixed IndexedDB queue eviction and retryable identity rejection scheduling.

## [0.1.0-alpha.2] - 2026-07-16

### Changed

- Renamed the canonical npm package to `@wetusco/wts-web-sdk`.
- Preserved the Protocol V2 API and runtime behavior without integration changes.

## [0.1.0-alpha.1] - 2026-07-16

### Added

- Consent-first Web Protocol V2 bootstrap and event delivery
- Explicit and optional SPA page-view tracking
- Typed custom events and decimal revenue
- Deterministic signed-link attribution
- Bounded IndexedDB queue, retry, idempotency, and multi-tab locking
- SSR-safe ESM/CJS builds and versioned IIFE with SHA-384 SRI
