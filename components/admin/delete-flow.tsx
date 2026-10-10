"use client";

import { useRef, useState, useTransition } from "react";
import { LockIcon, Trash2Icon, TriangleAlertIcon } from "lucide-react";
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
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import {
  BLOCKED_COPY,
  confirmMessage,
  DELETE_TOASTS,
  type Blocker,
  type DeleteCheck,
  type DeleteKind,
  type DeleteRemove,
} from "@/lib/delete-flow";

type View = "idle" | "confirm" | "blocked";

// A row's delete button and its two dialogs (spec 0005 AC-8). The click runs
// `check`; blockers open the blocked dialog, none opens the confirm. The
// confirm never opens over blockers, and a delete in flight cannot be
// dismissed.
export function DeleteFlow({
  kind,
  id,
  label,
  check,
  remove,
}: {
  readonly kind: DeleteKind;
  readonly id: string;
  readonly label: string;
  readonly check: DeleteCheck;
  readonly remove: DeleteRemove;
}) {
  const [view, setView] = useState<View>("idle");
  // Kept after the blocked dialog closes, so its list stays while it fades.
  const [blockers, setBlockers] = useState<readonly Blocker[]>([]);
  const [checking, startCheck] = useTransition();
  const [deleting, startDelete] = useTransition();
  const cancel = useRef<HTMLButtonElement>(null);
  const copy = BLOCKED_COPY[kind];
  const showBlocked = (found: readonly Blocker[]) => {
    setBlockers(found);
    setView("blocked");
  };

  const onCheck = () =>
    startCheck(async () => {
      try {
        const result = await check(id);
        if (!result.ok) return notifyError(DELETE_TOASTS.unavailable);
        if (result.value.length > 0) showBlocked(result.value);
        else setView("confirm");
      } catch {
        notifyError(DELETE_TOASTS.generic);
      }
    });

  const onDelete = () =>
    startDelete(async () => {
      try {
        const result = await remove(id);
        if (result.ok) {
          setView("idle");
          return notifySuccess(DELETE_TOASTS.deleted);
        }
        switch (result.error.kind) {
          case "blocked":
            // Someone started using it between the check and the delete.
            return showBlocked(result.error.blockers);
          case "failed":
            setView("idle");
            return notifyError(result.error.message);
          default: {
            const never: never = result.error;
            return never;
          }
        }
      } catch {
        setView("idle");
        notifyError(DELETE_TOASTS.generic);
      }
    });

  return (
    <>
      <Button
        variant="outline"
        size="icon"
        className="text-danger-strong hover:text-danger-strong"
        aria-label={`Delete ${label}`}
        disabled={checking}
        onClick={onCheck}
      >
        {checking ? (
          <Spinner aria-hidden="true" role={undefined} />
        ) : (
          <Trash2Icon aria-hidden="true" />
        )}
      </Button>

      <AlertDialog
        open={view === "confirm"}
        onOpenChange={(open) => {
          if (!open && !deleting) setView("idle");
        }}
      >
        <AlertDialogContent initialFocus={cancel}>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-crimson-100 text-danger-strong">
              <TriangleAlertIcon aria-hidden="true" />
            </AlertDialogMedia>
            <AlertDialogTitle>Delete this?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmMessage(label)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel ref={cancel} disabled={deleting}>
              Cancel
            </AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={deleting}
              onClick={onDelete}
            >
              {deleting ? <Spinner data-icon="inline-start" /> : null}
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={view === "blocked"}
        onOpenChange={(open) => {
          if (!open) setView("idle");
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="gap-0 p-6.5 sm:max-w-100"
        >
          <div className="mb-4 flex size-11 items-center justify-center rounded-lg bg-nile-blue-050 text-nile-blue">
            <LockIcon aria-hidden="true" className="size-5" />
          </div>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription className="mt-2">
            {copy.message(label)}
          </DialogDescription>
          <ul className="mt-3.5 flex max-h-40 flex-col gap-1.5 overflow-y-auto">
            {blockers.map((b) => (
              <li
                key={b.id}
                className="rounded-sm bg-cloud-mist px-3 py-2 text-sub font-medium text-fg1"
              >
                {b.label}
              </li>
            ))}
          </ul>
          <DialogFooter className="mt-5.5">
            <DialogClose render={<Button />}>Got it</DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
