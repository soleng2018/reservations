"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CircleAlertIcon,
  HistoryIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import type { savePortalResetAction } from "@/app/admin/actions";
import { ConfirmDialog } from "@/components/admin/confirm-dialog";
import { useLeaveGuard } from "@/components/admin/admin-shell";
import { GENERIC } from "@/components/admin/form-dialog";
import { PageBody } from "@/components/admin/page-body";
import { PageHeader } from "@/components/admin/page-header";
import { PortalResetRowDialog } from "@/components/admin/portal-reset-row-dialog";
import {
  PortalResetSettings,
  PortalResetSettingsFields,
} from "@/components/admin/portal-reset-settings";
import { PortalResetStartingList } from "@/components/admin/portal-reset-starting-list";
import { PortalResetSteps } from "@/components/admin/portal-reset-steps";
import { notifySuccess } from "@/components/notify";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { PortalResetMode } from "@/lib/db-enums";
import {
  appendEntry,
  entryFromChoice,
  entryView,
  isDirty,
  moveEntry,
  openChoices,
  removeEntry,
  replaceEntry,
  saveInput,
  startDraft,
  type Draft,
  type DraftEntry,
  type EditorStep,
  type EntryFields,
  type StartingChoice,
} from "@/lib/portal-reset/draft";
import { MODE_HELP } from "@/lib/portal-reset/mode";
import type { FieldErrors } from "@/lib/form-errors";
import type { ResetRowView } from "@/lib/portal-reset/view";

type Save = typeof savePortalResetAction;

type Props = {
  readonly version: number;
  readonly abortEmail: string | null;
  readonly mode: PortalResetMode;
  // "Maria on 27 Oct 2026, 1:19 PM", or null before the first Save.
  readonly lastSaved: string | null;
  // The saved list, as the editor starts from it.
  readonly steps: readonly EditorStep[];
  // The same list, as the read only table shows it.
  readonly rows: readonly ResetRowView[];
  // The starting list entries that are not in the table (AC-13).
  readonly starting: readonly StartingChoice[];
  readonly historyHref: string;
  readonly save: Save;
};

// One edit: the version the draft will send, and what it started from. Both
// are taken once, when Edit is confirmed, and do not follow later refreshes
// of the page (the repo rule for edit dialogs).
type Session = {
  readonly id: number;
  readonly version: number;
  readonly start: Draft;
};

// The Nile Portal Reset page, read only until the admin clicks Edit and
// confirms (spec 0022 AC-4, AC-5). Edit mode holds a draft in the browser;
// the one Save writes all of it.
export function PortalResetEditor(props: Props) {
  const [session, setSession] = useState<Session | null>(null);
  const [asking, setAsking] = useState(false);
  const opened = useRef(0);

  if (session !== null) {
    return (
      <Editing
        key={session.id}
        {...props}
        session={session}
        onExit={() => setSession(null)}
      />
    );
  }
  return (
    <>
      <PageHeader
        section="nile-portal-reset"
        action={
          <>
            <HistoryLink href={props.historyHref} />
            <Button onClick={() => setAsking(true)}>
              <PencilIcon data-icon="inline-start" aria-hidden="true" />
              Edit
            </Button>
          </>
        }
      />
      <PageBody>
        <PortalResetSettings
          abortEmail={props.abortEmail}
          mode={props.mode}
          lastSaved={props.lastSaved}
        />
        <PortalResetSteps rows={props.rows} />
      </PageBody>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title="Edit the reset list?"
        description="Changes apply to every Nile Portal reset after you save."
        confirmLabel="Edit"
        onConfirm={() => {
          opened.current += 1;
          setSession({
            id: opened.current,
            version: props.version,
            start: startDraft(props),
          });
        }}
      />
    </>
  );
}

function HistoryLink({ href }: { readonly href: string }) {
  const { intercept } = useLeaveGuard();
  return (
    <Link
      href={href}
      onClick={(e) => intercept(e, href)}
      className={buttonVariants({ variant: "outline" })}
    >
      <HistoryIcon data-icon="inline-start" aria-hidden="true" />
      History
    </Link>
  );
}

type Notice = { readonly kind: "stale" | "failed"; readonly message: string };
type Asking = "live" | "discard" | null;

const ROW_ERROR = /^steps\.(\d+)\.(.*)$/;

function Editing({
  session,
  lastSaved,
  starting,
  historyHref,
  save,
  onExit,
}: Props & {
  readonly session: Session;
  readonly onExit: () => void;
}) {
  const router = useRouter();
  const { setDirty } = useLeaveGuard();
  const [draft, setDraft] = useState(session.start);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  const [asking, setAsking] = useState<Asking>(null);
  const [saving, startSave] = useTransition();
  const [reloading, startReload] = useTransition();
  const pending = saving || reloading;
  const reloadStarted = useRef(false);
  const added = useRef(0);
  const dirty = isDirty(session.start, draft);

  // Unsaved changes: the shell asks before a link leaves, and the browser
  // before a reload or a closed tab.
  useEffect(() => {
    setDirty(dirty);
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, setDirty]);
  useEffect(() => () => setDirty(false), [setDirty]);

  // A change to the draft clears the errors: they name rows by place.
  const change = (next: Draft) => {
    setDraft(next);
    setErrors({});
  };

  const onSave = () =>
    startSave(async () => {
      setErrors({});
      setNotice(null);
      try {
        const result = await save(session.version, saveInput(draft));
        if (result.ok) {
          notifySuccess(
            result.value.changed ? "Reset list saved." : "Nothing to save.",
          );
          setDirty(false);
          onExit();
          return;
        }
        const { error } = result;
        switch (error.kind) {
          case "invalid":
            setErrors(error.fields);
            break;
          case "stale":
          case "failed":
            setNotice({ kind: error.kind, message: error.message });
            break;
          default: {
            const never: never = error;
            return never;
          }
        }
      } catch {
        setNotice({ kind: "failed", message: GENERIC });
      }
    });

  // Edit mode ends once the refresh has landed, so an Edit click right after
  // Reload opens on the new version, not the stale one.
  const onReload = () => {
    setDirty(false);
    startReload(() => {
      router.refresh();
    });
  };
  useEffect(() => {
    if (reloading) reloadStarted.current = true;
    else if (reloadStarted.current) {
      reloadStarted.current = false;
      onExit();
    }
  }, [reloading, onExit]);

  const rowErrors = (index: number): readonly string[] =>
    Object.entries(errors).flatMap(([path, message]) => {
      const match = ROW_ERROR.exec(path);
      return match !== null && Number(match[1]) === index
        ? [`${match[2]}: ${message}`]
        : [];
    });
  const rowIndex = (row: ResetRowView): number =>
    draft.steps.findIndex((s) => s.clientKey === row.id);
  const entryFor = (row: ResetRowView): DraftEntry | null =>
    draft.steps[rowIndex(row)] ?? null;
  const views = draft.steps.map(entryView);
  const rowProblems = Object.keys(errors).some((path) => ROW_ERROR.test(path));

  const apply = (fields: EntryFields, current: DraftEntry | null) => {
    if (current === null) {
      added.current += 1;
      change(
        appendEntry(draft, {
          ...fields,
          clientKey: `new-${added.current}`,
          id: null,
        }),
      );
    } else {
      change(replaceEntry(draft, { ...current, ...fields }));
    }
  };

  const addFromStarting = (choice: StartingChoice) => {
    added.current += 1;
    change(appendEntry(draft, entryFromChoice(choice, `new-${added.current}`)));
  };

  return (
    <>
      <PageHeader
        section="nile-portal-reset"
        action={
          <>
            <HistoryLink href={historyHref} />
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => (dirty ? setAsking("discard") : onExit())}
            >
              Discard
            </Button>
            <Button disabled={pending} onClick={onSave}>
              {pending ? <Spinner data-icon="inline-start" /> : null}
              Save
            </Button>
          </>
        }
      />
      <PageBody>
        {notice !== null ? (
          <Alert variant="destructive" role="alert">
            <CircleAlertIcon aria-hidden="true" />
            <AlertDescription className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <span>{notice.message}</span>
              {notice.kind === "stale" ? (
                <Button variant="outline" size="sm" onClick={onReload}>
                  Reload
                </Button>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}
        {Object.keys(errors).length > 0 ? (
          <Alert variant="destructive" role="alert">
            <CircleAlertIcon aria-hidden="true" />
            <AlertDescription>
              {rowProblems
                ? "Some steps have problems. They are listed under each step."
                : "Fix the problems marked below, then save again."}
              {errors.steps ? ` ${errors.steps}` : null}
              {errors.expectedVersion ? ` ${errors.expectedVersion}` : null}
            </AlertDescription>
          </Alert>
        ) : null}
        <PortalResetSettingsFields
          abortEmail={draft.abortEmail}
          mode={draft.mode}
          lastSaved={lastSaved}
          errors={errors}
          disabled={pending}
          onEmail={(abortEmail) => change({ ...draft, abortEmail })}
          onMode={(mode) =>
            mode === "live" && draft.mode !== "live"
              ? setAsking("live")
              : change({ ...draft, mode })
          }
        />
        <div className="flex flex-wrap justify-end gap-2">
          <PortalResetStartingList
            open={openChoices(starting, draft)}
            disabled={pending}
            onAdd={addFromStarting}
          />
          <PortalResetRowDialog
            trigger={
              <Button variant="outline" disabled={pending}>
                <PlusIcon data-icon="inline-start" aria-hidden="true" />
                Add row
              </Button>
            }
            entry={null}
            others={draft.steps}
            onApply={(fields) => apply(fields, null)}
          />
        </div>
        <PortalResetSteps
          rows={views}
          emptyDescription="A list needs at least one step. Add one to be able to save."
          problems={(row) => rowErrors(rowIndex(row))}
          reorder={{
            disabled: pending,
            onMove: (from, to) => change(moveEntry(draft, from, to)),
          }}
          actions={(row) => {
            const entry = entryFor(row);
            if (entry === null) return null;
            return (
              <>
                <PortalResetRowDialog
                  trigger={
                    <Button
                      variant="outline"
                      size="icon"
                      disabled={pending}
                      aria-label={`Edit ${entry.featureName}`}
                    >
                      <PencilIcon aria-hidden="true" />
                    </Button>
                  }
                  entry={entry}
                  others={draft.steps.filter(
                    (s) => s.clientKey !== entry.clientKey,
                  )}
                  onApply={(fields) => apply(fields, entry)}
                />
                <Button
                  variant="outline"
                  size="icon"
                  className="text-danger-strong hover:text-danger-strong"
                  disabled={pending}
                  aria-label={`Remove ${entry.featureName}`}
                  onClick={() => change(removeEntry(draft, entry.clientKey))}
                >
                  <Trash2Icon aria-hidden="true" />
                </Button>
              </>
            );
          }}
        />
      </PageBody>
      <ConfirmDialog
        open={asking === "live"}
        onOpenChange={(open) => {
          if (!open) setAsking(null);
        }}
        title="Switch to live?"
        description={MODE_HELP.live}
        confirmLabel="Use live mode"
        onConfirm={() => change({ ...draft, mode: "live" })}
      />
      <ConfirmDialog
        open={asking === "discard"}
        onOpenChange={(open) => {
          if (!open) setAsking(null);
        }}
        title="Discard your changes?"
        description="Your draft is thrown away and the saved list is shown."
        cancelLabel="Keep editing"
        confirmLabel="Discard"
        onConfirm={() => {
          setDirty(false);
          onExit();
        }}
      />
    </>
  );
}
