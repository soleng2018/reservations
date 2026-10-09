"use client";

import Script from "next/script";

declare global {
  interface Window {
    turnstile?: { reset: () => void };
  }
}

// Cloudflare Turnstile (spec 0001), rendered implicitly: the widget adds its
// token to the enclosing form as `cf-turnstile-response`.
export function Turnstile({ siteKey }: { readonly siteKey: string }) {
  return (
    <>
      <Script
        src="https://challenges.cloudflare.com/turnstile/v0/api.js"
        strategy="afterInteractive"
      />
      <div className="cf-turnstile" data-sitekey={siteKey} />
    </>
  );
}

// A token is single use: get a fresh one after each reply.
export function resetTurnstile(): void {
  window.turnstile?.reset();
}
