"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useTransition,
  type FormEvent,
  type ReactElement,
  type ReactNode,
  type TransitionStartFunction,
} from "react";
import Link from "next/link";
import { CircleAlertIcon, XIcon } from "lucide-react";
import type { AdminFormState } from "@/app/admin/actions";
import { FormErrorsContext } from "@/components/form-errors";
import { notifySuccess } from "@/components/notify";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";

export type AdminFormAction = (
  prev: AdminFormState,
  form: FormData,
) => Promise<AdminFormState>;

const IDLE: AdminFormState = { kind: "idle" };
export const GENERIC = "Something went wrong. Try again.";

// What a form's fields may do besides being saved (spec 0013 AC-27): run a
// side request in its own transition (Save stays off and the dialog stays
// open meanwhile), and show its answer through the same error display as a
// save (IDLE clears it). `saves` counts save answers, and `restartAt` is the
// count at the last one that spent a Google sign in, so a field can tell
// whether what it started is older than that (AC-28).
export type FormDialogControls = {
  readonly startAside: TransitionStartFunction;
  readonly asidePending: boolean;
  readonly onFieldErrors: (state: AdminFormState) => void;
  readonly saves: number;
  readonly restartAt: number | undefined;
};

const FormDialogContext = createContext<FormDialogControls | undefined>(
  undefined,
);

export function useFormDialog(): FormDialogControls {
  const controls = useContext(FormDialogContext);
  if (!controls) throw new Error("useFormDialog outside a FormDialog");
  return controls;
}

// The form modal (spec 0005 AC-7). Centered and 520px wide from the nav
// breakpoint up, a bottom sheet below it. The form lives inside the popup,
// so closing unmounts it: reopening starts empty, with no stale errors.
// While a save is pending nothing can close it, so its result never lands
// on a closed dialog. A form that loads its defaults (spec 0007 AC-3)
// starts on `onOpen`, keeps Save off with `canSave` until they arrive, and
// may drop them on `onClosed`, once the close animation is done.
export function FormDialog({
  trigger,
  title,
  action,
  onOpen,
  onClosed,
  canSave = true,
  children,
}: {
  readonly trigger: ReactElement;
  readonly title: string;
  readonly action: AdminFormAction;
  readonly onOpen?: () => void;
  readonly onClosed?: () => void;
  readonly canSave?: boolean;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [asidePending, startAside] = useTransition();
  const popup = useRef<HTMLDivElement>(null);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && (pending || asidePending)) return;
        setOpen(next);
        if (next) onOpen?.();
      }}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) onClosed?.();
      }}
    >
      <DialogTrigger render={trigger} />
      <DialogContent
        ref={popup}
        showCloseButton={false}
        initialFocus={() =>
          popup.current?.querySelector<HTMLElement>("[data-field]") ?? true
        }
        className="inset-x-0 top-auto bottom-0 left-0 flex max-h-[88dvh] w-full max-w-full translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-t-3xl rounded-b-none p-0 sm:max-w-full nav:top-1/2 nav:bottom-auto nav:left-1/2 nav:max-w-130 nav:-translate-x-1/2 nav:-translate-y-1/2 nav:rounded-3xl"
      >
        <FormBody
          title={title}
          action={action}
          canSave={canSave}
          pending={pending}
          startTransition={startTransition}
          asidePending={asidePending}
          startAside={startAside}
          onSaved={(message) => {
            setOpen(false);
            notifySuccess(message);
          }}
        >
          {children}
        </FormBody>
      </DialogContent>
    </Dialog>
  );
}

function FormBody({
  title,
  action,
  canSave,
  pending,
  startTransition,
  asidePending,
  startAside,
  onSaved,
  children,
}: {
  readonly title: string;
  readonly action: AdminFormAction;
  readonly canSave: boolean;
  readonly pending: boolean;
  readonly startTransition: TransitionStartFunction;
  readonly asidePending: boolean;
  readonly startAside: TransitionStartFunction;
  readonly onSaved: (message: string) => void;
  readonly children: ReactNode;
}) {
  const [state, setState] = useState<AdminFormState>(IDLE);
  const [saves, setSaves] = useState(0);
  const [restartAt, setRestartAt] = useState<number | undefined>(undefined);
  const form = useRef<HTMLFormElement>(null);
  const errors =
    state.kind === "error"
      ? { fields: state.fields, message: state.message }
      : { fields: {} };

  // After an error, focus the first invalid field in DOM order, or a control
  // that stands in for a field not shown yet (data-error-anchor).
  useEffect(() => {
    if (state.kind !== "error") return;
    form.current
      ?.querySelector<HTMLElement>('[aria-invalid="true"], [data-error-anchor]')
      ?.focus();
  }, [state]);

  // Submitted from onSubmit, not the form action, so React does not reset
  // the fields when the server returns an error.
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!canSave || asidePending) return;
    const data = new FormData(e.currentTarget);
    const attempt = saves + 1;
    startTransition(async () => {
      const next = await action(state, data).catch((): AdminFormState => ({
        kind: "error",
        message: GENERIC,
        fields: {},
      }));
      setState(next);
      setSaves(attempt);
      if (next.kind === "error" && next.restart) setRestartAt(attempt);
      if (next.kind === "saved") onSaved(next.message);
    });
  };

  const controls: FormDialogControls = {
    startAside,
    asidePending,
    onFieldErrors: setState,
    saves,
    restartAt,
  };

  return (
    <form
      ref={form}
      onSubmit={onSubmit}
      noValidate
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex items-center justify-between gap-4 border-b px-6 py-5">
        <DialogTitle>{title}</DialogTitle>
        <DialogClose
          disabled={pending || asidePending}
          aria-label="Close"
          render={
            <Button
              variant="ghost"
              size="icon"
              className="rounded-full bg-cloud-mist"
            />
          }
        >
          <XIcon aria-hidden="true" />
        </DialogClose>
      </div>

      <FormErrorsContext value={errors}>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5.5">
          <FormDialogContext value={controls}>{children}</FormDialogContext>
          {state.kind === "error" && state.link ? (
            <Link
              href={state.link.href}
              className="w-fit text-sm font-semibold text-primary underline-offset-4 hover:underline"
            >
              {state.link.label}
            </Link>
          ) : null}
          {state.kind === "error" && state.message ? (
            <Alert variant="destructive">
              <CircleAlertIcon aria-hidden="true" />
              <AlertDescription>{state.message}</AlertDescription>
            </Alert>
          ) : null}
        </div>
      </FormErrorsContext>

      <div className="flex justify-end gap-2.5 border-t px-6 py-4.5">
        <DialogClose
          disabled={pending || asidePending}
          render={<Button type="button" variant="outline" />}
        >
          Cancel
        </DialogClose>
        <Button type="submit" disabled={pending || asidePending || !canSave}>
          {pending ? <Spinner data-icon="inline-start" /> : null}
          Save
        </Button>
      </div>
    </form>
  );
}
