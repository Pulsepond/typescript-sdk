# Pulsepond TypeScript SDK

`@pulsepond/typescript-sdk` is the browser SDK for sending explicit,
privacy-conscious product events to a self-hosted Pulsepond Worker.

Version `0.1` is browser-only and ESM-only. It does not include a Node.js
transport, React bindings, automatic capture, or identity APIs.

## Install

```sh
pnpm add @pulsepond/typescript-sdk
```

The package is not published until the first release is approved. During
development, install the packed tarball produced by `pnpm pack`.

## Configure

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

## Identity persistence

The default is memory-only. No Cookie, local storage, or session storage is
read or written:

```ts
createPulsepond({
  endpoint: "https://events.example.com/v1/batch",
  writeKey: "ppw_v1_...",
  environment: "production",
});
```

Persistent random IDs require an explicit application-owned namespace:

```ts
createPulsepond({
  endpoint: "https://events.example.com/v1/batch",
  writeKey: "ppw_v1_...",
  environment: "production",
  persistence: "localStorage",
  storageNamespace: "museum_web",
});
```

The installation ID is stored in `localStorage`; the session ID is stored in
`sessionStorage` and rotates after 30 minutes of inactivity. Pending event
payloads are never persisted. The namespace, rather than the write key, keeps
the installation ID stable across key rotation.

Storage access may fail in restricted browser modes. The SDK then falls back
to memory and emits a redacted `storage_unavailable` diagnostic.

## Event contract

The SDK sends the closed Pulsepond v1 envelope. It generates and freezes these
fields when `track()` is called:

- lowercase RFC UUIDv7 `event_id`
- `schema_version: 1`
- UTC `occurred_at`
- `platform: "web"`
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
- Fetch uses `credentials: "omit"`, `referrerPolicy: "no-referrer"`,
  `redirect: "error"`, and `cache: "no-store"`.
- Batches are bounded by event count and 60,000 serialized UTF-8 bytes.
- `202 Accepted` is success. It means the Worker accepted the batch into its
  Queue; it does not promise that D1 already contains the events.
- Network failures, timeouts, `408`, `429`, and `5xx` responses receive bounded
  retries with jitter. `Retry-After` is honored up to 30 seconds.
- A multi-event `413` response is split without changing event IDs. A
  single-event `413` is terminal.
- Unsent events older than 23 hours are dropped before batching by default so
  one stale event cannot poison a whole server-validated batch.
- `pagehide` triggers one best-effort keepalive fetch. `sendBeacon` is not used
  because it cannot attach the publishable Bearer credential.

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
keep it secret. It grants event submission only; it never grants reads or
administrative access. Exact Origin policy, event/property allowlists, rate
limits, rotation, and revocation are required server-side controls.

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
| `persistence` | `"memory"` | Set to `"localStorage"` only after the application makes that privacy choice |
| `storageNamespace` | omitted | Required with persistent identity |
| `batchSize` | `20` | Between 1 and the protocol maximum of 100 |
| `flushIntervalMs` | `5000` | `0` disables timed flushes |
| `maxQueueSize` | `1000` | In-memory event-count bound |
| `eventTtlMs` | 23 hours | Align this with the source's server-side maximum event age |
| `onDiagnostic` | omitted | Receives redacted lifecycle and delivery status |

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
v1 schema and fixture suite, a production build, a real browser CORS/lifecycle
test, and an inspection of the npm tarball.

The browser test finds common Linux Chrome paths. Set
`PULSEPOND_CHROME_PATH=/absolute/path/to/chrome` when needed.

## Release

Version `0.1.0` requires one authenticated public publish because npm only
allows Trusted Publishing to be configured for an existing package. After
that bootstrap, configure the package for GitHub organization `Pulsepond`,
repository `typescript-sdk`, workflow `publish.yml`, with `npm publish`
allowed.

All later GitHub Releases publish the matching package version through npm
Trusted Publishing. The release tag must be `v<package.json version>` and its
commit must be part of `main`. The workflow uses short-lived OIDC credentials;
do not add an npm publish token to the repository.

## License

Apache-2.0
