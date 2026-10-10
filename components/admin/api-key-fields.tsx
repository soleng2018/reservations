"use client";

import { useState } from "react";
import { Field } from "@/components/field";
import { FormSelect } from "@/components/form-select";
import { Input } from "@/components/ui/input";
import type { ApiKeyType } from "@/lib/db-enums";

const TYPES = [
  { value: "IDP", label: "IDP" },
  { value: "AI", label: "AI" },
] as const;

export type ApiKeyDefaults = {
  readonly name: string;
  readonly type: ApiKeyType;
  readonly baseUrl: string;
};

const NEW_KEY: ApiKeyDefaults = { name: "", type: "IDP", baseUrl: "" };

// Spec 0006 AC-2 and AC-4, inside the form modal: empty to add, the row's
// name, type, and base URL to edit. The key field always starts empty, since
// the stored secret never reaches the browser; on edit, blank keeps it.
// Defaults are read once on open (the Testbed Types pattern). No maxLength
// on the key: a pasted secret must never be cut short without a word.
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
  const editing = lastChanged !== undefined;
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
        />
      </Field>
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
          defaultValue={defaults.baseUrl}
        />
      </Field>
      <Field
        path="secret"
        label="Key value"
        description={editing ? `Last changed ${lastChanged}` : undefined}
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
  );
}
