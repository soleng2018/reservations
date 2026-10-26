"use client";

import { useId, useState, type MouseEvent } from "react";
import { ExternalLinkIcon } from "lucide-react";
import {
  startGoogleSignInAction,
  type AdminFormState,
} from "@/app/admin/actions";
import { GENERIC, useFormDialog } from "@/components/admin/form-dialog";
import { Field } from "@/components/field";
import { useFormErrors } from "@/components/form-errors";
import { FormSelect } from "@/components/form-select";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { ApiKeyType, GoogleAuthMethod } from "@/lib/db-enums";

const TYPES = [
  { value: "IDP", label: "IDP" },
  { value: "AI", label: "AI" },
  { value: "CLOUDFLARE", label: "CLOUDFLARE" },
  { value: "GOOGLE", label: "GOOGLE" },
  { value: "CLEANUP", label: "CLEANUP" },
] as const satisfies readonly { value: ApiKeyType; label: string }[];

// Spec 0013 AC-25: Service account first, and selected on create.
const METHODS = [
  { value: "service_account", label: "Service account (Workspace)" },
  { value: "oauth", label: "Google sign in (personal Gmail, for testing)" },
] as const satisfies readonly { value: GoogleAuthMethod; label: string }[];

export type ApiKeyDefaults = {
  readonly name: string;
  readonly type: ApiKeyType;
  readonly baseUrl: string;
  // CLEANUP edit only: the URL's host, since the URL itself stays on the
  // server (spec 0021 AC-9).
  readonly maskedUrl: string;
  // GOOGLE only (spec 0013 AC-4, AC-29); empty (or the first method) for
  // every other type.
  readonly googleAuth: GoogleAuthMethod;
  readonly senderEmail: string;
  readonly calendarId: string;
  readonly devInbox: string;
  readonly opsBcc: string;
};

const NEW_KEY: ApiKeyDefaults = {
  name: "",
  type: "IDP",
  baseUrl: "",
  maskedUrl: "",
  googleAuth: "service_account",
  senderEmail: "",
  calendarId: "",
  devInbox: "",
  opsBcc: "",
};

// Spec 0006 AC-2 and AC-4, inside the form modal: empty to add, the row's
// name, type, and base URL to edit. The key field always starts empty, since
// the stored secret never reaches the browser; on edit, blank keeps it.
// Defaults are read once on open (the Testbed Types pattern). No maxLength
// on the key: a pasted secret must never be cut short without a word.
// Choosing GOOGLE (spec 0013 AC-1, AC-4, AC-25) swaps Base URL and Key value
// for the sign in method and its fields.
export function ApiKeyFields({
  defaults: initialDefaults = NEW_KEY,
  lastChanged: initialLastChanged,
}: {
  readonly defaults?: ApiKeyDefaults;
  // Edit only: the day the secret last changed, formatted by the page.
  readonly lastChanged?: string;
}) {
  const [defaults] = useState(initialDefaults);
  const [lastChanged] = useState(initialLastChanged);
  const [type, setType] = useState<ApiKeyType>(defaults.type);
  const editing = lastChanged !== undefined;
  const changedNote = editing ? `Last changed ${lastChanged}` : undefined;
  // A CLEANUP key's URL and secret stay on the server, so an edit of one
  // leaves either blank to keep it (spec 0021 AC-1).
  const keepsHook =
    editing && defaults.type === "CLEANUP" && type === "CLEANUP";
  return (
    <>
      <Field path="name" label="Name">
        <Input
          name="name"
          required
          maxLength={200}
          placeholder="e.g. Okta Production"
          defaultValue={defaults.name}
        />
      </Field>
      <Field path="type" label="Type">
        <FormSelect
          name="type"
          options={TYPES}
          placeholder="Choose a type"
          defaultValue={defaults.type}
          onValueChange={(v) => {
            const parsed = ApiKeyType.safeParse(v);
            if (parsed.success) setType(parsed.data);
          }}
        />
      </Field>
      {type === "GOOGLE" ? (
        <GoogleFields defaults={defaults} changedNote={changedNote} />
      ) : (
        <>
          <Field path="baseUrl" label="Base URL">
            <Input
              name="baseUrl"
              type="url"
              inputMode="url"
              required={!keepsHook}
              placeholder={
                keepsHook
                  ? `Leave blank to keep ${defaults.maskedUrl}`
                  : "https://…"
              }
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              defaultValue={defaults.type === "GOOGLE" ? "" : defaults.baseUrl}
            />
          </Field>
          <Field
            path="secret"
            label={type === "CLEANUP" ? "Signing secret" : "Key value"}
            description={
              type === "CLEANUP"
                ? `At least 16 characters. Every call is signed with it.${changedNote ? ` ${changedNote}.` : ""}`
                : changedNote
            }
          >
            <Input
              name="secret"
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              required={!editing}
              placeholder={
                editing
                  ? "Leave blank to keep the current key"
                  : "Secret key or token"
              }
            />
          </Field>
        </>
      )}
    </>
  );
}

// Spec 0013 AC-25, AC-29: the sign in method, then its fields. The edit
// dialog opens on the key's method; the stored credential is kept only
// while the method stays the same (the action enforces it).
function GoogleFields({
  defaults,
  changedNote,
}: {
  readonly defaults: ApiKeyDefaults;
  readonly changedNote: string | undefined;
}) {
  const [method, setMethod] = useState<GoogleAuthMethod>(defaults.googleAuth);
  const legendId = useId();
  const { fields } = useFormErrors();
  const methodError = fields.googleAuth;
  // An edit keeps the stored credential only on the key's own method.
  const keeps = (m: GoogleAuthMethod) =>
    changedNote !== undefined &&
    defaults.type === "GOOGLE" &&
    defaults.googleAuth === m;
  return (
    <>
      <FieldSet data-invalid={methodError ? true : undefined}>
        <FieldLegend
          id={legendId}
          variant="label"
          className="mb-0 text-[0.8125rem] font-semibold text-fg1"
        >
          Sign in method
        </FieldLegend>
        <RadioGroup
          name="googleAuth"
          aria-labelledby={legendId}
          value={method}
          onValueChange={(v) => {
            const parsed = GoogleAuthMethod.safeParse(v);
            if (parsed.success) setMethod(parsed.data);
          }}
          aria-invalid={methodError ? true : undefined}
          data-field="googleAuth"
        >
          {METHODS.map((m) => (
            <FieldLabel
              key={m.value}
              className="items-center font-normal text-fg1"
            >
              <RadioGroupItem value={m.value} />
              {m.label}
            </FieldLabel>
          ))}
        </RadioGroup>
        {methodError ? <FieldError>{methodError}</FieldError> : null}
      </FieldSet>
      {method === "service_account" ? (
        <>
          <Field
            path="keyFile"
            label="Key file"
            description={
              keeps("service_account")
                ? `Leave empty to keep the current key. ${changedNote}.`
                : "The service account JSON key from Google Cloud."
            }
          >
            <Input
              name="keyFile"
              type="file"
              accept=".json,application/json"
              required={!keeps("service_account")}
            />
          </Field>
          <Field
            path="senderEmail"
            label="Sender mailbox"
            description="The Workspace mailbox emails come from. The service account acts as it."
          >
            <Input
              name="senderEmail"
              type="email"
              required
              autoComplete="off"
              spellCheck={false}
              placeholder="labs@example.com"
              // A Google sign in's sender is the account, not a typed box.
              defaultValue={
                defaults.googleAuth === "service_account"
                  ? defaults.senderEmail
                  : ""
              }
            />
          </Field>
          <MailboxFields defaults={defaults} />
        </>
      ) : (
        <SignInFields
          defaults={defaults}
          signedInAs={keeps("oauth") ? defaults.senderEmail : undefined}
          changedNote={keeps("oauth") ? changedNote : undefined}
        />
      )}
    </>
  );
}

// The settings both methods share (spec 0013 AC-1).
function MailboxFields({ defaults }: { readonly defaults: ApiKeyDefaults }) {
  return (
    <>
      <Field path="calendarId" label="Calendar ID">
        <Input
          name="calendarId"
          required
          maxLength={255}
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          placeholder="…@group.calendar.google.com"
          defaultValue={defaults.calendarId}
        />
      </Field>
      <Field
        path="devInbox"
        label="Dev inbox"
        description="Test and dev- bookings are sent here. Leave blank to not send them. Use a mailbox outside the sender's account."
      >
        <Input
          name="devInbox"
          type="email"
          autoComplete="off"
          spellCheck={false}
          defaultValue={defaults.devInbox}
        />
      </Field>
      <Field
        path="opsBcc"
        label="Ops BCC"
        description="Gets a copy of every learner email. Use a mailbox outside the sender's account."
      >
        <Input
          name="opsBcc"
          type="email"
          autoComplete="off"
          spellCheck={false}
          defaultValue={defaults.opsBcc}
        />
      </Field>
    </>
  );
}

// Spec 0013 AC-25, AC-27, AC-28: Google sign in. "Sign in with Google" runs
// its own request with the chosen client file (the dialog keeps every field
// and file), then shows the Google link and the field for the address
// Google opens. The started state outlives later field errors, and is
// dropped once a save spent its code (`restartAt`), which clears the pasted
// address too.
function SignInFields({
  defaults,
  signedInAs,
  changedNote,
}: {
  readonly defaults: ApiKeyDefaults;
  // Edit only, on a key that already signs in this way (AC-29).
  readonly signedInAs: string | undefined;
  readonly changedNote: string | undefined;
}) {
  const { startAside, asidePending, onFieldErrors, saves, restartAt } =
    useFormDialog();
  const { fields } = useFormErrors();
  const errorId = useId();
  const [started, setStarted] = useState<{
    readonly url: string;
    // The save count when it started, against `restartAt`.
    readonly at: number;
  } | null>(null);
  const live =
    started !== null && (restartAt === undefined || started.at >= restartAt)
      ? started
      : null;
  // An error about the address while its field isn't shown (a save that
  // needs a new sign in) is shown under the button instead.
  const buttonError = live ? undefined : fields.returnUrl;

  const start = (e: MouseEvent<HTMLButtonElement>) => {
    const form = e.currentTarget.form;
    if (!form) return;
    const data = new FormData(form);
    const at = saves;
    startAside(async () => {
      const next = await startGoogleSignInAction(data).catch(
        (): AdminFormState => ({ kind: "error", message: GENERIC, fields: {} }),
      );
      if (next.kind === "started") {
        setStarted({ url: next.url, at });
        onFieldErrors({ kind: "idle" });
      } else onFieldErrors(next);
    });
  };

  return (
    <>
      {signedInAs ? (
        <p className="text-sm text-fg2">
          Signed in as{" "}
          <span className="font-semibold break-all text-fg1">{signedInAs}</span>
        </p>
      ) : null}
      <Field
        path="clientFile"
        label="OAuth client file"
        description={
          signedInAs
            ? `Choose the client file again to sign in again. ${changedNote}.`
            : "The Desktop app OAuth client JSON from Google Cloud."
        }
      >
        <Input name="clientFile" type="file" accept=".json,application/json" />
      </Field>
      <MailboxFields defaults={defaults} />
      <div className="flex flex-col gap-2">
        <Button
          type="button"
          variant="outline"
          className="w-fit"
          disabled={asidePending}
          onClick={start}
          aria-describedby={buttonError ? errorId : undefined}
          data-error-anchor={buttonError ? true : undefined}
        >
          {asidePending ? <Spinner data-icon="inline-start" /> : null}
          Sign in with Google
        </Button>
        {buttonError ? (
          <FieldError id={errorId} role={undefined}>
            {buttonError}
          </FieldError>
        ) : null}
      </div>
      {live === null ? null : (
        <>
          <a
            href={live.url}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonVariants({ className: "w-fit" })}
          >
            Open Google sign in
            <ExternalLinkIcon data-icon="inline-end" aria-hidden="true" />
          </a>
          <Field
            path="returnUrl"
            label="Google sign in address"
            description="After you approve, Google opens a page that won't load. Copy its address from the address bar and paste it here."
          >
            <Input
              // A new sign in starts with an empty address.
              key={live.url}
              name="returnUrl"
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              placeholder="http://127.0.0.1:47613/?state=…"
            />
          </Field>
        </>
      )}
    </>
  );
}
