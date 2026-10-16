"use client";

import { useRef, useState, useTransition } from "react";
import { TriangleAlertIcon } from "lucide-react";
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
import { RESCHEDULE_MESSAGES } from "@/lib/booking-input";
import { cancelAccessLine } from "@/lib/manage-reservations";
import type { Result } from "@/lib/result";

// Spec 0011 AC-4, AC-5: a learner's "Cancel reservation", with a confirm.
// The page binds the booking's id and version into `action`; `start`
// arrives formatted in the account zone. A cancel in flight cannot be
// dismissed. The action revalidates the list, so the card goes on its own.
export function CancelReservationButton({
  testbed,
  start,
  current,
  action,
}: {
  readonly testbed: string;
  readonly start: string;
  readonly current: boolean;
  readonly action: () => Promise<Result<void, "stale">>;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const keep = useRef<HTMLButtonElement>(null);

  const onConfirm = () =>
    startTransition(async () => {
      try {
        const done = await action();
        setOpen(false);
        if (done.ok) notifySuccess("Reservation cancelled.");
        else notifyError(RESCHEDULE_MESSAGES.stale);
      } catch {
        setOpen(false);
        notifyError(RESCHEDULE_MESSAGES.generic);
      }
    });

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="text-danger-strong hover:bg-crimson-100 hover:text-danger-strong"
        onClick={() => setOpen(true)}
      >
        Cancel reservation
      </Button>
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (!next && !pending) setOpen(false);
        }}
      >
        <AlertDialogContent initialFocus={keep}>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-crimson-100 text-danger-strong">
              <TriangleAlertIcon aria-hidden="true" />
            </AlertDialogMedia>
            <AlertDialogTitle>Cancel this reservation?</AlertDialogTitle>
            <AlertDialogDescription>
              This will free up {testbed} on {start}.
              {cancelAccessLine("learner", current)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel ref={keep} disabled={pending}>
              Keep it
            </AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={onConfirm}
            >
              {pending ? <Spinner data-icon="inline-start" /> : null}
              Cancel reservation
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
