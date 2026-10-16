"use client";

import { useState } from "react";
import { Field } from "@/components/field";
import { FormSelect } from "@/components/form-select";
import { Input } from "@/components/ui/input";
import { ApiKeyType } from "@/lib/db-enums";

const TYPES = [
  { value: "IDP", label: "IDP" },
  { value: "AI", label: "AI" },
  { value: "CLOUDFLARE", label: "CLOUDFLARE" },
  { value: "GOOGLE", label: "GOOGLE" },
] as const satisfies readonly { value: ApiKeyType; label: string }[];

export type ApiKeyDefaults = {
  readonly name: string;
  readonly type: ApiKeyType;
  readonly baseUrl: string;
  // GOOGLE only (spec 0013 AC-4); empty for every other type.
  readonly senderEmail: string;
  readonly calendarId: string;
  readonly devInbox: string;
  readonly opsBcc: string;
};

const NEW_KEY: ApiKeyDefaults = {
  name: "",
  type: "IDP",
  baseUrl: "",
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
// Choosing GOOGLE (spec 0013 AC-1, AC-4) swaps Base URL and Key value for
// the key file and the mailbox and calendar settings.
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
              required
              placeholder="https://…"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              defaultValue={defaults.type === "GOOGLE" ? "" : defaults.baseUrl}
            />
          </Field>
          <Field path="secret" label="Key value" description={changedNote}>
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

// The key file input always starts empty: the stored key never comes back,
// and on edit an empty input keeps it.
function GoogleFields({
  defaults,
  changedNote,
}: {
  readonly defaults: ApiKeyDefaults;
  readonly changedNote: string | undefined;
}) {
  const editing = changedNote !== undefined;
  return (
    <>
      <Field
        path="keyFile"
        label="Key file"
        description={
          editing
            ? `Leave empty to keep the current key. ${changedNote}.`
            : "The service account JSON key from Google Cloud."
        }
      >
        <Input
          name="keyFile"
          type="file"
          accept=".json,application/json"
          required={!editing}
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
          defaultValue={defaults.senderEmail}
        />
      </Field>
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
        description="Test and dev- bookings are sent here. Leave blank to not send them."
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
        description="Gets a copy of every learner email."
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
