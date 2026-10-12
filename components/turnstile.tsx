"use client";

import Script from "next/script";
import { useEffect, useRef, useState } from "react";

type TurnstileApi = {
  readonly render: (
    el: HTMLElement,
    options: {
      readonly sitekey: string;
      readonly callback: (token: string) => void;
      readonly "expired-callback": () => void;
      readonly "error-callback": () => void;
    },
  ) => string | undefined;
  readonly reset: (widgetId: string) => void;
  readonly remove: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

// Cloudflare Turnstile, rendered explicitly (spec 0010 AC-7), the one script
// mode app wide. Each instance keeps its own widget id: a change of
// `resetSignal` resets it (a token is single use), and unmounting removes
// it. The widget still writes the hidden `cf-turnstile-response` input, so it
// works inside a plain <form> too. `onToken` gets each token, and null when
// it expires or fails. `resetSignal` is any value; each change resets.
export function Turnstile({
  siteKey,
  onToken,
  resetSignal,
}: {
  readonly siteKey: string;
  readonly onToken?: (token: string | null) => void;
  readonly resetSignal?: unknown;
}) {
  const host = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const tokenRef = useRef(onToken);
  // Already loaded after a client navigation: render at once.
  const [ready, setReady] = useState(
    () => typeof window !== "undefined" && window.turnstile !== undefined,
  );

  useEffect(() => {
    tokenRef.current = onToken;
  }, [onToken]);

  useEffect(() => {
    const api = window.turnstile;
    const el = host.current;
    // The id guard stops a second widget under StrictMode's double effect.
    if (!ready || !api || !el || widgetId.current !== null) return;
    widgetId.current =
      api.render(el, {
        sitekey: siteKey,
        callback: (token) => tokenRef.current?.(token),
        "expired-callback": () => tokenRef.current?.(null),
        "error-callback": () => tokenRef.current?.(null),
      }) ?? null;
    return () => {
      if (widgetId.current !== null) api.remove(widgetId.current);
      widgetId.current = null;
    };
  }, [ready, siteKey]);

  const lastSignal = useRef(resetSignal);
  useEffect(() => {
    if (lastSignal.current === resetSignal) return;
    lastSignal.current = resetSignal;
    if (widgetId.current !== null) window.turnstile?.reset(widgetId.current);
    tokenRef.current?.(null);
  }, [resetSignal]);

  return (
    <>
      <Script
        src={SCRIPT}
        strategy="afterInteractive"
        onReady={() => setReady(true)}
      />
      <div ref={host} data-slot="turnstile" className="min-h-16.25" />
    </>
  );
}
