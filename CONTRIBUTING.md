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

CI runs the complete `pnpm check` quality gate for every pull request and push
to `main`. Keep the workflow token read-only and do not add secrets to the
pull-request workflow.

## Release

This repository uses an intentionally small release flow for one package:

1. Update the version in `package.json` in a pull request.
2. Run `pnpm check`, push the branch, and wait for CI to pass.
3. Merge the pull request into `main`.
4. Create a stable GitHub Release from the merged commit with tag
   `v<package.json version>`.
5. Confirm that the `Publish` workflow succeeds and that npm exposes the new
   version with provenance.

The release workflow verifies that the tag matches `package.json`, that the
tagged commit belongs to `main`, and that the full quality gate passes before
publishing. npm authentication uses the configured GitHub OIDC Trusted
Publisher. Never add an npm token to GitHub.

GitHub prereleases are deliberately ignored because this project does not yet
define an npm prerelease dist-tag policy.
