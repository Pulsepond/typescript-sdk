# Contributing

Thank you for helping improve the Pulsepond TypeScript SDK.

## Development

Use Node.js 22.12 or newer and the pnpm version declared in `package.json`.

```sh
pnpm install
pnpm check
```

Every behavior change should include a test. Delivery changes should cover
retry classification, stable event identity, bounded memory, browser lifecycle
behavior, and redacted diagnostics where relevant.

Keep version `0.1` browser-only. React bindings, a Node transport, automatic
capture, and a generic plugin system belong in separately justified work.

## Privacy and security

Do not add automatic collection of URLs, headers, Cookies, DOM content, user
identity, search text, or request bodies. Never include write keys, event
bodies, or property values in logs, errors, diagnostics, test snapshots, or
URLs.

The write key is publishable but must remain scoped to ingestion. Changes that
weaken Origin checks, source allowlists, rate limits, rotation, or revocation
belong in the Pulsepond Worker rather than this SDK.

## Pull requests

Explain the user-visible behavior, delivery or privacy tradeoffs, and the
checks you ran. Prefer small changes with a complete testable outcome.
