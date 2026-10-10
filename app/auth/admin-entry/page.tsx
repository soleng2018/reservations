import type { Metadata } from "next";
import Image from "next/image";
import { LockIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { signInWithSso } from "../actions";

// Served only at ADMIN_ENTRY_PATH (proxy.ts rewrites to it and 404s this
// path). Unlisted, not secret: /admin re-checks the role (AC-1, AC-3).
export const metadata: Metadata = {
  title: "Sign in",
  robots: { index: false, follow: false },
};

// The mock's admin sign in card (spec 0005 AC-10).
export default function AdminEntryPage() {
  return (
    <main
      id="content"
      className="flex flex-1 items-center justify-center bg-[radial-gradient(600px_400px_at_50%_-10%,var(--color-nile-sky-100),transparent)] p-6"
    >
      <div className="w-full max-w-102 rounded-4xl border bg-card px-9 py-10 shadow-lg">
        <div className="mb-5.5 flex justify-center">
          <Image
            src="/brand/nile-logo.png"
            alt="Nile"
            width={60}
            height={30}
            className="h-7.5 w-auto"
            priority
          />
        </div>
        <div className="mb-7 text-center">
          <p className="mb-2.5 text-xs font-bold tracking-[0.08em] text-nile-blue uppercase">
            Nile Hands-On Labs · Admin
          </p>
          <h1 className="mb-1.5 text-card-title font-semibold tracking-[-0.02em] text-fg1">
            Sign in
          </h1>
          <p className="text-sm text-fg2">
            Testbed &amp; reservation administration
          </p>
        </div>
        <form action={signInWithSso}>
          <Button type="submit" size="lg" className="w-full">
            <LockIcon data-icon="inline-start" aria-hidden="true" />
            Sign in with SSO
          </Button>
        </form>
        <p className="mt-5.5 text-center text-pill text-fg3">
          Admin access only. Sign in is handled by your identity provider (SSO).
        </p>
      </div>
    </main>
  );
}
