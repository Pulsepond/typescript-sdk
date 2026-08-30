# Pulsepond TypeScript SDK

`@pulsepond/typescript-sdk` sends explicit, privacy-conscious product events
from browsers, modern Node.js applications, and Cloudflare Workers to a
self-hosted Pulsepond Worker.

Version `0.2` is ESM-only. It does not include automatic capture or user
identity APIs. The same repository also owns the thin `@pulsepond/react`
binding so React does not grow a second transport or event contract.

## Install

```sh
pnpm add @pulsepond/typescript-sdk
```

For local unreleased changes, install the packed tarball produced by
`pnpm pack`.

## React binding

React applications install the core SDK and its optional binding:

```sh
pnpm add @pulsepond/typescript-sdk @pulsepond/react
```

```tsx
import { createPulsepond } from "@pulsepond/typescript-sdk";
import { PulsepondProvider, usePulsepond } from "@pulsepond/react";

const pulsepond = createPulsepond({
  endpoint: "https://events.example.com/v1/batch",
  writeKey: "ppw_v1_...",
  environment: "production",
});

root.render(
  <PulsepondProvider client={pulsepond}>
    <App />
  </PulsepondProvider>,
);
```

`PulsepondProvider` stores the application-owned client in React context and
`usePulsepond()` returns it. The binding never creates a client or tracks
routes, renders, clicks, URLs, or component data automatically. See
[`packages/react`](packages/react) for its complete lifecycle and React Server
Component guidance.

## Browser client

Create one client for a Pulsepond source. `endpoint` is the exact public
ingestion route, including `/v1/batch`.

```ts
import { createPulsepond } from "@pulsepond/typescript-sdk";

const pulsepond = createPulsepond({
  endpoint: "https://events.example.com/v1/batch",
  writeKey: "ppw_v1_...",
  environment: "production",
  appVersion: "1.4.0",
  release: "web@1.4.0",
});

const eventId = pulsepond.track("view_work", {
  work_id: "work_123",
});
```

`track()` returns the event's UUIDv7, or `null` if the bounded in-memory queue
is full. Invalid event names or properties throw `PulsepondValidationError`
before anything is enqueued.

Call `flush()` when an application needs an explicit delivery attempt:

```ts
await pulsepond.flush();
```

Call `shutdown()` during application teardown or hot-module replacement. It
removes the page lifecycle listener and makes one final best-effort delivery:

```ts
await pulsepond.shutdown();
```

`reset()` discards unsent events and rotates the random installation and
session IDs. It cannot retract an event that the Worker has already accepted.

## Server client

Server applications use the same bounded batching, retry, TTL, and protocol
implementation without browser storage or lifecycle behavior:

```ts
import { createPulsepondServer } from "@pulsepond/typescript-sdk";

const pulsepond = createPulsepondServer({
  endpoint: "https://events.example.com/v1/batch",
  writeKey: "ppw_v1_...",
  environment: "production",
  appVersion: "1.4.0",
  release: "api@1.4.0",
});

pulsepond.track(
  "purchase_success",
  {
    anonymousInstallationId: installationId,
    sessionId,
  },
  { currency: "JPY", value: 1200 },
);

await pulsepond.flush();
```

The application must supply a canonical lowercase UUIDv4 or UUIDv7 for both
identifiers on every event. The SDK does not derive IDs from an IP address,
request headers, a user account, or process-global state, and it does not
persist them. This keeps session semantics owned by the application instead of
silently treating a server process as one installation.

Create a dedicated Pulsepond source for server traffic with
`origin_mode: "forbidden"`. Use `"optional"` only when a source intentionally
accepts both browser and non-browser clients. The server client does not forge
an `Origin` header, and a source with `origin_mode: "required"` will reject
normal server requests.

Call `shutdown()` from the application's graceful-shutdown path. It makes one
final bounded delivery attempt and permanently closes the client. In short-lived
serverless handlers, explicitly await `flush()` or attach it to the platform's
background-lifetime primitive, such as Cloudflare Workers `ctx.waitUntil()`.

## Browser identity persistence

The browser client defaults to memory-only identity. No Cookie, local storage,
or session storage is read or written:

```ts
createPulsepond({
  endpoint: "https://events.example.com/v1/batch",
  writeKey: "ppw_v1_...",
  environment: "production",
});
```

Random IDs that survive navigation require an explicit application-owned namespace. Use
`sessionStorage` when the installation identity should disappear with the browser tab:

```ts
createPulsepond({
  endpoint: "https://events.example.com/v1/batch",
  writeKey: "ppw_v1_...",
  environment: "production",
  persistence: "sessionStorage",
  storageNamespace: "installer_flow",
});
```

Use `localStorage` only when the application has made an explicit decision to keep the random
installation identity across browser sessions:

```ts
createPulsepond({
  endpoint: "https://events.example.com/v1/batch",
  writeKey: "ppw_v1_...",
  environment: "production",
  persistence: "localStorage",
  storageNamespace: "museum_web",
});
```

With `sessionStorage`, both random IDs remain inside the current tab. With `localStorage`, the
installation ID is stored in `localStorage` while the session ID remains in `sessionStorage` and
rotates after 30 minutes of inactivity. Pending event payloads are never persisted. The namespace,
rather than the write key, keeps the installation ID stable across key rotation.

Storage access may fail in restricted browser modes. The SDK then falls back
to memory and emits a redacted `storage_unavailable` diagnostic.

## Event contract

The SDK sends the closed Pulsepond v1 envelope. It generates and freezes these
fields when `track()` is called:

- lowercase RFC UUIDv7 `event_id`
- `schema_version: 1`
- UTC `occurred_at`
- `platform: "web"` for the browser client or `"server"` for the server client
- configured application and environment fields
- random installation and session IDs
- a defensive, frozen copy of the explicit properties

Event and property names are ASCII slugs. Properties are flat and limited to
32 values. A value can only be `null`, a boolean, a JavaScript-safe integer, or
a trimmed printable ASCII string of at most 256 characters.

The SDK deliberately does not reproduce the server's source allowlists or PII
heuristics. Those policies remain authoritative at ingestion.

## Delivery behavior

- Requests go only to the configured `/v1/batch` URL.
- The only request headers set by the SDK are `Authorization` and
  `Content-Type`.
- Browser Fetch uses `credentials: "omit"`, `referrerPolicy: "no-referrer"`,
  `redirect: "error"`, and `cache: "no-store"`. Server Fetch omits the
  browser-only options.
- Batches are bounded by event count and 60,000 serialized UTF-8 bytes.
- `202 Accepted` is success. It means the Worker accepted the batch into its
  Queue; it does not promise that D1 already contains the events.
- Network failures, timeouts, `408`, `429`, and `5xx` responses receive bounded
  retries with jitter. `Retry-After` is honored up to 30 seconds.
- A multi-event `413` response is split without changing event IDs. A
  single-event `413` is terminal.
- Unsent events older than 23 hours are dropped before batching by default so
  one stale event cannot poison a whole server-validated batch.
- Browser `pagehide` triggers one best-effort keepalive fetch. `sendBeacon` is
  not used because it cannot attach the publishable Bearer credential.

Delivery is asynchronous and best-effort. Events can be dropped by explicit
queue, age, retry, or lifecycle bounds, and ambiguous network failures can
produce duplicates. Do not depend on strict ordering, immediate query
visibility, or exactly-once delivery.

## Privacy and credentials

The SDK collects nothing automatically. It does not read or send:

- URLs, query parameters, referrers, or page titles
- application Cookies, application Authorization headers, or other application
  state
- DOM or page content
- search text, feedback bodies, or user identity
- User-Agent or device metadata as event properties

The write key is a publishable, source-scoped credential. Browser code cannot
keep it secret. Server applications should still inject it through their
normal secret manager and must never send it to a browser, log, URL, event
property, or error report. It grants event submission only; it never grants
reads or administrative access. Exact Origin policy, event/property
allowlists, rate limits, rotation, and revocation are required server-side
controls.

The browser still adds normal networking metadata such as `Origin`,
`User-Agent`, and Fetch Metadata headers to the HTTP request. The collector
needs those headers for controls such as Origin enforcement, but should not
copy them into analytics events or persist them as event properties.

Random identifiers and the word "anonymous" are not a compliance guarantee.
The application owner remains responsible for disclosure, consent, event
design, and regional requirements.

Diagnostics contain only a stable code, retryability, an optional HTTP status,
and a dropped-event count. They never contain the write key, event body, or
property values.

```ts
const pulsepond = createPulsepond({
  endpoint: "https://events.example.com/v1/batch",
  writeKey: "ppw_v1_...",
  environment: "production",
  onDiagnostic(diagnostic) {
    console.warn("Pulsepond delivery status", diagnostic);
  },
});
```

## Configuration

| Option | Default | Notes |
| --- | --- | --- |
| `endpoint` | required | HTTPS URL with the exact `/v1/batch` path; HTTP is allowed only on localhost |
| `writeKey` | required | Publishable `ppw_v1_...` source credential |
| `environment` | required | ASCII slug, up to 32 characters |
| `appVersion` | omitted | Trimmed printable ASCII, up to 64 characters |
| `release` | omitted | Trimmed printable ASCII, up to 128 characters |
| `batchSize` | `20` | Between 1 and the protocol maximum of 100 |
| `flushIntervalMs` | `5000` | `0` disables timed flushes |
| `maxQueueSize` | `1000` | In-memory event-count bound |
| `eventTtlMs` | 23 hours | Align this with the source's server-side maximum event age |
| `onDiagnostic` | omitted | Receives redacted lifecycle and delivery status |

Browser clients also accept:

| Option | Default | Notes |
| --- | --- | --- |
| `persistence` | `"memory"` | `"sessionStorage"` survives navigation in one tab; `"localStorage"` also survives browser sessions |
| `storageNamespace` | omitted | Required with either browser-storage mode |

Server clients reject both browser identity-storage options and require a
`PulsepondServerEventContext` argument on every `track()` call.

## Development

Requirements:

- Node.js 22.12 or newer
- pnpm 10.34.5
- a system Chrome or Chromium for the real-browser contract test

```sh
pnpm install
pnpm check
```

`pnpm check` runs strict TypeScript checking, unit tests, the pinned Pulsepond
v1 schema and fixture suite, production builds for the core and React packages,
a real browser CORS/lifecycle test, and inspections of both npm tarballs.

The browser test finds common Linux Chrome paths. Set
`PULSEPOND_CHROME_PATH=/absolute/path/to/chrome` when needed.

## Release

Pull requests and pushes to `main` run the complete `pnpm check` quality gate.
Stable GitHub Releases publish the matching package through npm Trusted
Publishing. Core tags use `v<package.json version>`; React tags use
`react-v<packages/react/package.json version>`. Release commits must be part of
`main`.

The publish workflow reruns the complete quality gate and uses short-lived
OIDC credentials with npm provenance. It ignores GitHub prereleases so they
cannot accidentally replace the npm `latest` tag. Do not add an npm publish
token to the repository. See [CONTRIBUTING.md](CONTRIBUTING.md) for the release
procedure.

## License

Apache-2.0
