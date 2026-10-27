"use client";

import { useState } from "react";
import { EyeIcon, EyeOffIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { Field, type FieldControlProps } from "@/components/field";
import { useFormErrors } from "@/components/form-errors";
import { FormSelect, type SelectOption } from "@/components/form-select";
import { Button } from "@/components/ui/button";
import { FieldError, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  MAX_TESTBED_CLIENTS,
  type TestbedClientInput,
} from "@/lib/catalog-input";
import {
  TESTBED_DOMAIN_HINT,
  groupChoiceLabel,
  TESTBED_GROUP_NAME_HINT,
  TESTBED_NAME_HINT,
  type GroupChoice,
  type TestbedEditDefaults,
} from "@/lib/testbeds";

// The mock's order: Wireless first, and the default for a new row.
const KINDS = [
  { value: "wireless", label: "Wireless" },
  { value: "wired", label: "Wired" },
] as const;

const NONE = { value: "", label: "None" } as const;

type Row = { readonly key: number; readonly client?: TestbedClientInput };

// Spec 0004 AC-2, spec 0007 AC-2, AC-3, spec 0017 AC-1, and spec 0018 AC-2,
// inside the form modal: empty to add, the loaded testbed to edit. Defaults are
// read once (the admin row edit rule). The Name is what learners see and stays
// editable. The Domain is read only and never posted (spec 0017 AC-20). The Group Name is the Authentik group's name: chosen from
// `groupChoices` on add (spec 0017 AC-14), then shown read only on edit (and
// never posted). Saving a new testbed looks that group up again, so a failure
// there arrives under the Group Name field or as the modal's form level
// message. Choosing a group shows its domain (AC-20).
export function TestbedFields({
  types,
  idps,
  defaults: initialDefaults,
  groupChoices,
  groupNotice,
  onGroupDomain,
}: {
  readonly types: readonly SelectOption[];
  readonly idps: readonly SelectOption[];
  readonly defaults?: TestbedEditDefaults;
  readonly groupChoices?: readonly GroupChoice[];
  readonly groupNotice?: string;
  // Add only: the chosen group's domain (null when it has none, or before a
  // choice), so the dialog can keep Save off (AC-22).
  readonly onGroupDomain?: (domain: string | null) => void;
}) {
  const [defaults] = useState(initialDefaults);
  // Stable keys for the client rows, so removing one keeps the others'
  // input. Plain numbers: random UUIDs are missing on plain http (dev), see
  // tests/client-secure-context.test.ts.
  const [rows, setRows] = useState<readonly Row[]>(() =>
    (defaults?.clients ?? []).map((client, key) => ({ key, client })),
  );
  const [group, setGroup] = useState<string | null>(null);
  const { fields } = useFormErrors();
  // AC-20: Domain is read only. On add it follows the chosen group.
  const domain = groupChoices?.find((c) => c.name === group)?.domain ?? "";
  const chooseGroup = (name: string) => {
    setGroup(name);
    onGroupDomain?.(groupChoices?.find((c) => c.name === name)?.domain ?? null);
  };
  const full = rows.length >= MAX_TESTBED_CLIENTS;
  // AC-3: a saved key that is gone or no longer an IDP shows as None.
  const idp = idps.some((o) => o.value === defaults?.idpApiKeyId)
    ? (defaults?.idpApiKeyId ?? NONE.value)
    : NONE.value;

  return (
    <>
      <Field path="name" label="Name" description={TESTBED_NAME_HINT}>
        <Input
          name="name"
          required
          maxLength={200}
          autoComplete="off"
          placeholder="e.g. Wireless Lab 1"
          defaultValue={defaults?.name}
        />
      </Field>
      {defaults ? (
        <Field
          path="groupName"
          label="Group Name"
          description={TESTBED_GROUP_NAME_HINT.edit}
        >
          <Input
            readOnly
            value={defaults.groupName}
            className="bg-bg-inset font-mono text-fg2"
          />
        </Field>
      ) : (
        <Field
          path="groupName"
          label="Group Name"
          description={groupNotice ?? TESTBED_GROUP_NAME_HINT.create}
        >
          <FormSelect
            name="groupName"
            options={(groupChoices ?? []).map((c) => ({
              value: c.name,
              label: groupChoiceLabel(c),
              disabled: c.domain === null,
            }))}
            placeholder="Choose a group"
            value={group}
            onValueChange={chooseGroup}
            disabled={(groupChoices ?? []).length === 0}
          />
        </Field>
      )}
      <Field path="domain" label="Domain" description={TESTBED_DOMAIN_HINT}>
        <Input
          readOnly
          className="bg-bg-inset font-mono text-fg2"
          placeholder="Choose a group first"
          value={defaults ? defaults.domain : domain}
        />
      </Field>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          path="testbedTypeId"
          label="Testbed type"
          description={
            types.length === 0 ? "Add a testbed type first." : undefined
          }
        >
          <FormSelect
            name="testbedTypeId"
            options={types}
            placeholder="Choose a type"
            defaultValue={defaults?.testbedTypeId}
          />
        </Field>
        <Field path="idpApiKeyId" label="IDP">
          <FormSelect
            name="idpApiKeyId"
            options={[NONE, ...idps]}
            placeholder={NONE.label}
            defaultValue={idp}
          />
        </Field>
      </div>
      <Field path="portalUrl" label="Nile Portal URL">
        <Input
          name="portalUrl"
          type="url"
          inputMode="url"
          required
          spellCheck={false}
          className="font-mono"
          placeholder="https://portal.nilesecure.com/…"
          defaultValue={defaults?.portalUrl}
        />
      </Field>
      <Field path="lmsUrl" label="LMS URL">
        <Input
          name="lmsUrl"
          type="url"
          inputMode="url"
          required
          spellCheck={false}
          className="font-mono"
          placeholder="https://learn.nilesecure.com/…"
          defaultValue={defaults?.lmsUrl}
        />
      </Field>

      <FieldSet
        className="gap-2.5"
        data-invalid={fields.clients ? true : undefined}
      >
        <div className="flex items-center justify-between gap-3">
          <FieldLegend
            variant="label"
            className="mb-0 text-[0.8125rem] font-semibold text-fg1"
          >
            Clients
          </FieldLegend>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-sm border-dashed border-border-strong text-nile-blue"
            disabled={full}
            // Rows stay in ascending key order, so last + 1 is unused.
            onClick={() =>
              setRows([...rows, { key: (rows.at(-1)?.key ?? -1) + 1 }])
            }
          >
            <PlusIcon data-icon="inline-start" aria-hidden="true" />
            Add client
          </Button>
        </div>
        {fields.clients ? (
          <FieldError role={undefined}>{fields.clients}</FieldError>
        ) : null}
        {full ? (
          <p className="text-pill text-fg3">
            A testbed can have at most {MAX_TESTBED_CLIENTS} clients.
          </p>
        ) : null}
        {rows.length === 0 ? (
          <p className="text-pill text-fg3">
            No clients yet. Add wireless or wired clients for this testbed.
          </p>
        ) : null}
        {rows.map((row, i) => (
          <ClientRow
            key={row.key}
            index={i}
            client={row.client}
            onRemove={() => setRows(rows.filter((r) => r.key !== row.key))}
          />
        ))}
      </FieldSet>
    </>
  );
}

// One client: name and URL, then the OS login, then kind and remove (the
// mock's three lines). Inputs submit as parallel lists in row order.
function ClientRow({
  index,
  client,
  onRemove,
}: {
  readonly index: number;
  readonly client?: TestbedClientInput;
  readonly onRemove: () => void;
}) {
  const n = index + 1;
  return (
    <div
      role="group"
      aria-label={`Client ${n}`}
      className="grid grid-cols-1 gap-3 rounded-md border p-3 sm:grid-cols-2 sm:items-start"
    >
      <Field path={`clients.${index}.name`} label="Client name">
        <Input
          name="clientName"
          required
          maxLength={200}
          defaultValue={client?.name}
        />
      </Field>
      <Field path={`clients.${index}.url`} label="Client URL">
        <Input
          name="clientUrl"
          type="url"
          inputMode="url"
          required
          spellCheck={false}
          className="font-mono"
          placeholder="https://…"
          defaultValue={client?.url}
        />
      </Field>
      <Field path={`clients.${index}.osUsername`} label="OS username">
        <Input
          name="clientOsUsername"
          maxLength={200}
          autoComplete="off"
          spellCheck={false}
          defaultValue={client?.osUsername ?? ""}
        />
      </Field>
      <Field path={`clients.${index}.osPassword`} label="OS password">
        <SecretInput
          name="clientOsPassword"
          toggleLabel={`Show OS password of client ${n}`}
          defaultValue={client?.osPassword ?? ""}
        />
      </Field>
      <div className="flex items-end gap-3 sm:col-span-2">
        <Field path={`clients.${index}.kind`} label="Kind" className="w-40">
          <FormSelect
            name="clientKind"
            options={KINDS}
            placeholder="Kind"
            defaultValue={client?.kind ?? "wireless"}
          />
        </Field>
        <Button
          type="button"
          variant="ghost"
          size="icon-lg"
          className="ml-auto bg-crimson-100 text-danger-strong hover:bg-crimson-100 hover:text-danger-strong"
          aria-label={`Remove client ${n}`}
          onClick={onRemove}
        >
          <Trash2Icon aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

// A masked input with a show toggle. Inside a Field, the field's id and aria
// props land on the input. Never autofilled: these are lab VM logins, not
// the admin's own.
function SecretInput({
  name,
  toggleLabel,
  defaultValue,
  ...control
}: FieldControlProps & {
  readonly name: string;
  readonly toggleLabel: string;
  readonly defaultValue: string;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <Input
        {...control}
        name={name}
        type={shown ? "text" : "password"}
        autoComplete="off"
        spellCheck={false}
        maxLength={200}
        className="pr-11"
        defaultValue={defaultValue}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="absolute top-1/2 right-1.5 -translate-y-1/2 text-fg2"
        aria-label={toggleLabel}
        aria-pressed={shown}
        onClick={() => setShown(!shown)}
      >
        {shown ? (
          <EyeOffIcon aria-hidden="true" />
        ) : (
          <EyeIcon aria-hidden="true" />
        )}
      </Button>
    </div>
  );
}
