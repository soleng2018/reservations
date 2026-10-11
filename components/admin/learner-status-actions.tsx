"use client";

import { useRef, useState, useTransition } from "react";
import { MailIcon, UserRoundXIcon } from "lucide-react";
import type {
  DeactivateError,
  ReactivateError,
} from "@/app/admin/users/actions";
import { notifyError, notifySuccess } from "@/components/notify";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { Blocker } from "@/lib/delete-flow";
import { deactivatedToast, LEARNER_MESSAGES } from "@/lib/learners";
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

const deactivateMessage = (e: DeactivateError): string => {
  switch (e) {
    case "booking_pending":
      return LEARNER_MESSAGES.bookingPending;
    case "refused":
      return LEARNER_MESSAGES.refused;
    case "unavailable":
      return LEARNER_MESSAGES.unavailable;
    case "not_found":
      return LEARNER_MESSAGES.gone;
    default: {
      const never: never = e;
      return never;
    }
  }
};

// AC-8: the click lists the bookings that will be cancelled, then a confirm
// shows them. A deactivation in flight cannot be dismissed.
export function DeactivateLearnerButton({
  name,
  check,
  action,
}: {
  readonly name: string;
  readonly check: () => Promise<Result<readonly Blocker[], "unavailable">>;
  readonly action: () => Promise<
    Result<{ readonly cancelled: number }, DeactivateError>
  >;
}) {
  const [open, setOpen] = useState(false);
  // Kept after the dialog closes, so the list stays while it fades.
  const [bookings, setBookings] = useState<readonly Blocker[]>([]);
  const [checking, startCheck] = useTransition();
  const [saving, startSave] = useTransition();
  const cancel = useRef<HTMLButtonElement>(null);

  const onCheck = () =>
    startCheck(async () => {
      try {
        const found = await check();
        if (!found.ok) return notifyError(LEARNER_MESSAGES.generic);
        setBookings(found.value);
        setOpen(true);
      } catch {
        notifyError(LEARNER_MESSAGES.generic);
      }
    });

  const onConfirm = () =>
    startSave(async () => {
      try {
        const done = await action();
        setOpen(false);
        if (done.ok)
          notifySuccess(deactivatedToast(name, done.value.cancelled));
        else notifyError(deactivateMessage(done.error));
      } catch {
        setOpen(false);
        notifyError(LEARNER_MESSAGES.generic);
      }
    });

  return (
    <>
      <Button variant="outline" disabled={checking} onClick={onCheck}>
        {checking ? <Spinner data-icon="inline-start" /> : null}
        Deactivate user
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (!next && !saving) setOpen(false);
        }}
      >
        <AlertDialogContent initialFocus={cancel}>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-crimson-100 text-danger-strong">
              <UserRoundXIcon aria-hidden="true" />
            </AlertDialogMedia>
            <AlertDialogTitle>Deactivate {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              They&apos;ll be signed out and can&apos;t sign in until
              reactivated.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {bookings.length > 0 ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-fg2">
                These reservations will be cancelled:
              </p>
              {/* Focusable, so a keyboard can scroll a long list. */}
              <ul
                tabIndex={0}
                aria-label="Reservations to cancel"
                className="flex max-h-40 flex-col gap-1.5 overflow-y-auto rounded-sm"
              >
                {bookings.map((b) => (
                  <li
                    key={b.id}
                    className="rounded-sm bg-cloud-mist px-3 py-2 text-sub font-medium text-fg1"
                  >
                    {b.label}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel ref={cancel} disabled={saving}>
              Cancel
            </AlertDialogCancel>
            <Button variant="destructive" disabled={saving} onClick={onConfirm}>
              {saving ? <Spinner data-icon="inline-start" /> : null}
              Deactivate
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

const reactivateMessage = (e: ReactivateError): string => {
  switch (e) {
    case "authentik_missing":
      return LEARNER_MESSAGES.authentikMissing;
    case "refused":
      return LEARNER_MESSAGES.refused;
    case "unavailable":
      return LEARNER_MESSAGES.unavailable;
    case "not_found":
      return LEARNER_MESSAGES.gone;
    default: {
      const never: never = e;
      return never;
    }
  }
};

// AC-9: no confirm. Cancelled bookings stay cancelled.
export function ReactivateLearnerButton({
  name,
  action,
}: {
  readonly name: string;
  readonly action: () => Promise<Result<void, ReactivateError>>;
}) {
  const [pending, startTransition] = useTransition();
  const onClick = () =>
    startTransition(async () => {
      try {
        const done = await action();
        if (done.ok) notifySuccess(`Reactivated ${name}.`);
        else notifyError(reactivateMessage(done.error));
      } catch {
        notifyError(LEARNER_MESSAGES.generic);
      }
    });

  return (
    <Button variant="outline" disabled={pending} onClick={onClick}>
      {pending ? <Spinner data-icon="inline-start" /> : null}
      Reactivate user
    </Button>
  );
}
