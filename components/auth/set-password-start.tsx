"use client";

import { useActionState, useEffect } from "react";
import { useFormStatus } from "react-dom";
import type { StartState } from "@/app/set-password/[token]/actions";
import { AlreadySetView, DeadView } from "@/components/auth/set-password-views";
import { notifyError } from "@/components/notify";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { SET_PASSWORD_COPY } from "@/lib/set-password-link";

// Spec 0014 AC-9, AC-10: the Live view. The page binds the token into
// `action`; a click either leaves for Authentik or answers why it can't.
export function SetPasswordStart({
  action,
  email,
  siteKey,
}: {
  readonly action: (prev: StartState, form: FormData) => Promise<StartState>;
  readonly email: string;
  readonly siteKey: string;
}) {
  const [state, formAction] = useActionState(action, undefined);

  // The link is still live after these, so the button stays (design.md:
  // a failure with no field is an error toast).
  useEffect(() => {
    if (state?.state === "unavailable")
      notifyError(SET_PASSWORD_COPY.unavailable);
    if (state?.state === "limited") notifyError(SET_PASSWORD_COPY.limited);
  }, [state]);

  if (state?.state === "dead") return <DeadView siteKey={siteKey} />;
  if (state?.state === "already_set") return <AlreadySetView />;
  return (
    <form action={formAction} className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">
          {SET_PASSWORD_COPY.liveHeading}
        </h1>
        <p className="text-sm break-words text-muted-foreground">for {email}</p>
      </div>
      <StartButton />
      <p className="text-sm text-muted-foreground">
        {SET_PASSWORD_COPY.liveHelper}
      </p>
    </form>
  );
}

function StartButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="cta" disabled={pending}>
      {pending ? <Spinner data-icon="inline-start" /> : null}
      {SET_PASSWORD_COPY.liveButton}
    </Button>
  );
}
