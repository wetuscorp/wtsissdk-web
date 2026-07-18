# wts.is Web SDK examples

`vite` and `plain-html` demonstrate consent-first production page tracking.
The host application continues to own browser routing; the Web SDK does not
call a deep-link `handle` method or navigate on its own.

## SDK Test & Validate

The dashboard pairing QR uses:

```text
https://<web-app-host>/_wts/test/pair?pairing=<dashboard-issued-token>
```

Before an application applies normal routing or fallback logic, detect that
HTTPS path and call `await client.joinTestSession(incomingUrl)`. Pairing links
are not normal application routes. Then show
`client.getTestSessionDiagnostics()` and call
`await client.runTestSessionProbes()`.

If the probe result contains a ready `experienceDecision`, render its typed
content only in a test preview. After the real preview is visible or its CTA is
used, call `client.reportTestSessionExperienceInteraction("impression")` or
`"action"`. Do not use the normal Experiences renderer or normal interaction
queue for this validation path. `client.probeTestSessionUrl(url)` is an
event-free resolver check; `await client.leaveTestSession()` closes the
short-lived session.

Do not put the dashboard-issued pairing credential in source code, logs, or
application storage. The isolated queue is bounded and separate from
production analytics. These APIs require a matching published web SDK release;
the `0.3.0-alpha.1` source line is not a package-publication claim.
