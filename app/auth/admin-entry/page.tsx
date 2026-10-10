import type { Metadata } from "next";
import { signInWithSso } from "../actions";

// Served only at ADMIN_ENTRY_PATH (proxy.ts rewrites to it and 404s this
// path). Unlisted, not secret: /admin re-checks the role (AC-1, AC-3).
export const metadata: Metadata = {
  title: "Sign in",
  robots: { index: false, follow: false },
};

export default function AdminEntryPage() {
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <form
        action={signInWithSso}
        className="flex w-full max-w-sm flex-col gap-6 rounded-lg border p-8"
      >
        <h1 className="text-xl font-semibold">Nile Hands-On Lab admin</h1>
        <button
          type="submit"
          className="rounded-md bg-black px-4 py-2 text-white dark:bg-white dark:text-black"
        >
          Sign in with SSO
        </button>
      </form>
    </main>
  );
}
