# Security and privacy

## Reporting

Report suspected vulnerabilities privately to `security@wetus.co`. Include the affected version, reproduction steps, expected impact, and any suggested mitigation. Do not publish credentials, source keys tied to a private environment, attribution tokens, or customer event data in an issue.

## Data boundary

The source key is a public identifier, not a secret. Security is enforced with exact allowed origins, entitlement and contract checks, rate limits, schema validation, and event UUID idempotency.

The SDK does not collect IDFA, GAID, browser fingerprints, canvas/device fingerprints, third-party cookies, DOM text, form fields, raw IP addresses, raw user agents, URL query strings, or fragments. Anonymous and session UUIDs are first-party values and are HMAC-pseudonymized by the collector.

## Supported versions

Security fixes are applied to the latest prerelease during the alpha period. After 1.0, the current major version receives security fixes according to the published support policy.
