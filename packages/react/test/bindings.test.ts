import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PulsepondClient } from "@pulsepond/typescript-sdk";
import {
  PulsepondProvider,
  PulsepondReactError,
  usePulsepond,
} from "../src/index.js";

function client(): PulsepondClient & {
  readonly calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    track(eventName) {
      calls.push(`track:${eventName}`);
      return "01890f3e-e4b8-7cc3-98c8-7f0d7b4c9a10";
    },
    async flush() {
      calls.push("flush");
    },
    reset() {
      calls.push("reset");
    },
    async shutdown() {
      calls.push("shutdown");
    },
  };
}

test("returns the exact application-owned client without automatic side effects", () => {
  const pulsepond = client();
  let observed: PulsepondClient | undefined;

  function Probe() {
    observed = usePulsepond();
    return createElement("span", null, "ready");
  }

  const markup = renderToStaticMarkup(
    createElement(
      PulsepondProvider,
      { client: pulsepond },
      createElement(Probe),
    ),
  );

  assert.equal(markup, "<span>ready</span>");
  assert.equal(observed, pulsepond);
  assert.deepEqual(pulsepond.calls, []);
});

test("fails closed when a component is missing its provider", () => {
  function Probe() {
    usePulsepond();
    return null;
  }

  assert.throws(
    () => renderToStaticMarkup(createElement(Probe)),
    (error) =>
      error instanceof PulsepondReactError &&
      error.message === "usePulsepond must be rendered below PulsepondProvider",
  );
});

test("uses the nearest provider for independently configured application trees", () => {
  const outer = client();
  const inner = client();
  const observed: PulsepondClient[] = [];

  function Probe() {
    observed.push(usePulsepond());
    return null;
  }

  renderToStaticMarkup(
    createElement(
      PulsepondProvider,
      { client: outer },
      createElement(Probe),
      createElement(
        PulsepondProvider,
        { client: inner },
        createElement(Probe),
      ),
    ),
  );

  assert.deepEqual(observed, [outer, inner]);
  assert.deepEqual(outer.calls, []);
  assert.deepEqual(inner.calls, []);
});
