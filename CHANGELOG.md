# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and Semantic Versioning.

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
