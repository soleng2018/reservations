import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ResendSetPassword } from "@/components/auth/resend-set-password";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { Button } from "@/components/ui/button";
import { currentSession } from "@/server/auth/require";
import { turnstileEnv } from "@/server/env";
import { signInWithSso } from "../auth/actions";

export const metadata: Metadata = { title: "Manage your reservation" };

// Public before sign in, the learner area after (spec 0003). Signed in admins
// belong in the console; the role decides the landing (AC-2).
export default async function ReservationsPage() {
  const current = await currentSession();
  if (current?.user.role === "admin") redirect("/admin");
  if (current?.user.status === "deactivated")
    redirect("/auth/error?reason=deactivated");

  if (!current)
    return (
      <main className="flex flex-1 items-center justify-center p-6">
        <div className="flex w-full max-w-sm flex-col gap-8 rounded-lg border p-8">
          <form action={signInWithSso} className="flex flex-col gap-6">
            <h1 className="text-xl font-semibold">
              Manage an existing reservation
            </h1>
            <p className="text-sm text-muted-foreground">
              Sign in with the account you set up from your booking email.
            </p>
            <Button type="submit">Sign in</Button>
          </form>
          <ResendSetPassword siteKey={turnstileEnv().TURNSTILE_SITE_KEY} />
        </div>
      </main>
    );

  // Placeholder learner area until the reservations slice lands.
  return (
    <main className="flex flex-1 flex-col gap-2 p-8">
      <h1 className="text-xl font-semibold">Your reservations</h1>
      <p>Signed in as {current.user.name}.</p>
      <SignOutButton />
    </main>
  );
}
