import { signInWithSso } from "@/app/auth/actions";
import { ResendSetPassword } from "@/components/auth/resend-set-password";
import { Button } from "@/components/ui/button";
import { SET_PASSWORD_COPY } from "@/lib/set-password-link";

// Spec 0014 AC-9: the two views a set password link shows when it can't
// start the flow, rendered by the page, or by the button after a click that
// found the link gone.

// Opened again after the first sign in: a way in, not a resend form.
export function AlreadySetView() {
  return (
    <form action={signInWithSso} className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">{SET_PASSWORD_COPY.alreadySet}</h1>
      <Button type="submit">Sign in</Button>
    </form>
  );
}

// One message for every case, so a token reveals nothing beyond "not live".
export function DeadView({ siteKey }: { readonly siteKey: string }) {
  return (
    <>
      <h1 className="text-xl font-semibold">{SET_PASSWORD_COPY.dead}</h1>
      <ResendSetPassword siteKey={siteKey} />
    </>
  );
}
