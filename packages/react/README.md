# Pulsepond React

`@pulsepond/react` provides thin React bindings for
[`@pulsepond/typescript-sdk`](https://github.com/Pulsepond/typescript-sdk). It
keeps one explicitly created Pulsepond client available through React context
without introducing a second transport, queue, identity, or event contract.

Version `0.1` contains only `PulsepondProvider` and `usePulsepond`. It does not
automatically track routes, renders, clicks, URLs, or component data.

## Install

```sh
pnpm add @pulsepond/react @pulsepond/typescript-sdk
```

React 18.3 or 19 is required as a peer dependency.

## Configure once

Create the client outside the component tree and pass it to the provider:

```tsx
import { createPulsepond } from "@pulsepond/typescript-sdk";
import { PulsepondProvider } from "@pulsepond/react";

const pulsepond = createPulsepond({
  endpoint: "https://events.example.com/v1/batch",
  writeKey: "ppw_v1_...",
  environment: "production",
  appVersion: "1.4.0",
  release: "web@1.4.0",
});

root.render(
  <PulsepondProvider client={pulsepond}>
    <App />
  </PulsepondProvider>,
);
```

Creating the client outside render keeps it stable across rerenders and React
Strict Mode development checks. The provider does not call `shutdown()` when
it unmounts because it does not own the supplied client. The application that
created the client remains responsible for its lifecycle.

## Track explicitly

Use the client only at the point where the product action is known:

```tsx
import { usePulsepond } from "@pulsepond/react";

export function FollowButton({ exhibitionId }: { exhibitionId: string }) {
  const pulsepond = usePulsepond();

  return (
    <button
      onClick={() => {
        pulsepond.track("follow_exhibition", {
          exhibition_id: exhibitionId,
        });
      }}
    >
      Follow
    </button>
  );
}
```

`usePulsepond()` throws `PulsepondReactError` when no provider is present. It
never creates a fallback client, because a silent fallback could send to the
wrong project or conceal an incomplete integration.

All validation, privacy, credentials, persistence, batching, retry, and
delivery semantics belong to `@pulsepond/typescript-sdk`. The write key is
publishable rather than secret, identity is memory-only by default, and no
event is collected automatically. Read the
[core SDK documentation](https://github.com/Pulsepond/typescript-sdk) before
enabling persistent random identifiers.

## Server rendering and React Server Components

The published entry is marked as a React client boundary because context and
hooks cannot run in a React Server Component. With Next.js App Router, import
`PulsepondProvider` and `usePulsepond` only from a Client Component. Do not pass
a Pulsepond client through Server Component props: class instances are not a
serializable server-to-client contract.

Traditional server rendering of a Client Component remains safe when the
application supplies a client-compatible object. This package itself does not
access `window`, start timers, or create a browser client. Create the browser
client in browser-owned application bootstrap rather than while executing a
server or RSC module.

## Development

Use Node.js 22.12 or newer and pnpm 10.34.5 from the repository root:

```sh
pnpm install
pnpm check
```

The shared quality gate checks both the core TypeScript SDK and React binding.

## Release

Stable GitHub Releases tagged `react-v<package version>` publish through npm
Trusted Publishing. The release commit must belong to `main`; the workflow
reruns the complete repository quality gate and uses short-lived OIDC
credentials with provenance. Because npm only allows a Trusted Publisher to be
configured for an existing package, maintainers must follow the one-time
bootstrap procedure in the repository's
[`CONTRIBUTING.md`](../../CONTRIBUTING.md) before the first automated release.

## License

Apache-2.0
