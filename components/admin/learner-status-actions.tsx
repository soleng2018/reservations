"use client";

import { useTransition } from "react";
import { MailIcon } from "lucide-react";
import { notifyError, notifySuccess } from "@/components/notify";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { LEARNER_MESSAGES } from "@/lib/learners";
import type { Result } from "@/lib/result";

// The user detail page's status buttons (spec 0008 AC-7 to AC-9). Each
// takes a Server Action the page bound to the learner's id, and reports
// the outcome as a toast.

// AC-7: queues a set password email, at most one per hour.
export function ResendSetPasswordButton({
  action,
}: {
  readonly action: () => Promise<Result<string, "not_eligible">>;
}) {
  const [pending, startTransition] = useTransition();
  const onClick = () =>
    startTransition(async () => {
      try {
        const sent = await action();
        if (sent.ok) notifySuccess(sent.value);
        else notifyError(LEARNER_MESSAGES.notEligible);
      } catch {
        notifyError(LEARNER_MESSAGES.generic);
      }
    });

  return (
    <Button variant="outline" disabled={pending} onClick={onClick}>
      {pending ? (
        <Spinner data-icon="inline-start" />
      ) : (
        <MailIcon data-icon="inline-start" aria-hidden="true" />
      )}
      Resend set password email
    </Button>
  );
}
