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

Keep the browser and server transports on the same protocol, queue, delivery,
and diagnostics implementation. Browser-only identity and lifecycle behavior
must not leak into server requests. React bindings stay thin and live in
`packages/react`; automatic capture and a generic plugin system require
separate justification.

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

This repository uses one quality gate and separate release tags for two npm
packages:

1. Update the relevant version in `package.json` or
   `packages/react/package.json` in a pull request.
2. Run `pnpm check`, push the branch, and wait for CI to pass.
3. Merge the pull request into `main`.
4. Create a stable GitHub Release from the merged commit. Use
   `v<package.json version>` for `@pulsepond/typescript-sdk` or
   `react-v<packages/react/package.json version>` for `@pulsepond/react`.
5. Confirm that the matching publish workflow succeeds and that npm exposes
   the new version with provenance.

The release workflow verifies that the tag matches `package.json`, that the
tagged commit belongs to `main`, and that the full quality gate passes before
publishing. npm authentication uses the configured GitHub OIDC Trusted
Publisher. Never add an npm token to GitHub.

GitHub prereleases and prerelease version strings are deliberately rejected
because this project does not yet define an npm prerelease dist-tag policy.

### Bootstrap the React package

npm requires a package to exist before it can be assigned a Trusted Publisher.
For the first `@pulsepond/react` version only, a maintainer must:

1. Publish the referenced `@pulsepond/typescript-sdk` version first; consumers
   must be able to resolve the dependency written into the packed manifest.
2. Run `pnpm check` on the exact `main` commit.
3. Pack `packages/react` with pnpm so `workspace:^` becomes a registry version.
4. Publish that tarball interactively with npm account 2FA, using public access
   and explicitly disabling provenance because the command is not running in
   GitHub Actions.
5. Configure the package's GitHub Actions Trusted Publisher for organization
   `Pulsepond`, repository `typescript-sdk`, workflow `publish-react.yml`, and
   the `npm publish` action.

Do not create a stable GitHub Release for that manually published version: it
would ask the automated workflow to publish the same immutable version again.
All later React versions use the normal `react-v<version>` release flow and
OIDC provenance.
