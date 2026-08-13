"use client";

import { createContext, createElement, useContext } from "react";
import type { ReactElement, ReactNode } from "react";
import type { PulsepondClient } from "@pulsepond/typescript-sdk";

const PulsepondContext = createContext<PulsepondClient | null | undefined>(
  undefined,
);

export interface PulsepondProviderProps {
  readonly children?: ReactNode;
  readonly client: PulsepondClient;
}

/** Makes one application-owned Pulsepond client available to descendants. */
export function PulsepondProvider({
  children,
  client,
}: PulsepondProviderProps): ReactElement {
  return createElement(PulsepondContext.Provider, { value: client }, children);
}

/** Returns the exact client supplied by the nearest PulsepondProvider. */
export function usePulsepond(): PulsepondClient {
  const client = useContext(PulsepondContext);
  if (client === null || client === undefined) {
    throw new PulsepondReactError(
      "usePulsepond must be rendered below PulsepondProvider",
    );
  }
  return client;
}

export class PulsepondReactError extends Error {
  override readonly name = "PulsepondReactError";
}

export type {
  EventProperties,
  EventPropertyValue,
  PulsepondClient,
  PulsepondDiagnostic,
} from "@pulsepond/typescript-sdk";
