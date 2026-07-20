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

If the probe result contains a ready `experienceDecision`, the SDK renders it
automatically through an isolated test queue. Test impressions and actions do
not enter the production Experience queue. `client.probeTestSessionUrl(url)` is an
event-free resolver check; `await client.leaveTestSession()` closes the
short-lived session.

Do not put the dashboard-issued pairing credential in source code, logs, or
application storage. The isolated queue is bounded and separate from
production analytics. These APIs require a matching published web SDK release;
the `0.5.0-alpha.1` source line is not a package-publication claim.
