"use client";

import { useActionState, useEffect } from "react";
import {
  resendSetPassword,
  type ResendState,
} from "@/app/reservations/actions";
import { resetTurnstile, Turnstile } from "@/components/turnstile";

// "Resend the set password email" (spec 0003 AC-8). The Turnstile widget
// adds its token to the form as `cf-turnstile-response`.
export function ResendSetPassword({ siteKey }: { readonly siteKey: string }) {
  const [state, action, pending] = useActionState<ResendState, FormData>(
    resendSetPassword,
    undefined,
  );

  // A token is single use: get a fresh one after each reply.
  useEffect(() => {
    if (state) resetTurnstile();
  }, [state]);

  return (
    <form action={action} className="flex flex-col gap-3">
      <h2 className="text-sm font-medium">
        Didn&apos;t get the set password email?
      </h2>
      <label className="flex flex-col gap-1 text-sm">
        Email
        <input
          name="email"
          type="email"
          required
          autoComplete="email"
          className="rounded-md border px-3 py-2"
        />
      </label>
      <Turnstile siteKey={siteKey} />
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border px-4 py-2 text-sm disabled:opacity-50"
      >
        {pending ? "Sending…" : "Resend the email"}
      </button>
      <p
        role="status"
        aria-live="polite"
        className="text-sm text-muted-foreground"
      >
        {state?.message}
      </p>
    </form>
  );
}
