"use client";

import { useRef, useState, useTransition } from "react";
import { CalendarXIcon } from "lucide-react";
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
import { LEARNER_MESSAGES } from "@/lib/learners";
import { cancelAccessLine } from "@/lib/manage-reservations";
import type { Result } from "@/lib/result";

// Spec 0008 AC-10: an Upcoming or Current row's Cancel, with a confirm. The
// page binds the booking's id and version into `action`; `start` and `end`
// arrive formatted in the admin's zone. A cancel in flight cannot be
// dismissed.
export function BookingCancelButton({
  testbed,
  start,
  end,
  current,
  action,
}: {
  readonly testbed: string;
  readonly start: string;
  readonly end: string;
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
        else notifyError(LEARNER_MESSAGES.stale);
      } catch {
        setOpen(false);
        notifyError(LEARNER_MESSAGES.generic);
      }
    });

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        aria-label={`Cancel the ${testbed} reservation starting ${start}`}
        onClick={() => setOpen(true)}
      >
        Cancel
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
              <CalendarXIcon aria-hidden="true" />
            </AlertDialogMedia>
            <AlertDialogTitle>Cancel this reservation?</AlertDialogTitle>
            <AlertDialogDescription>
              {testbed}, {start} to {end}. The testbed is freed at once.
              {cancelAccessLine("admin", current)}
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
