"use client";

import { useMemo, useState } from "react";
import { Field } from "@/components/field";
import { FormSelect } from "@/components/form-select";
import { Input } from "@/components/ui/input";
import { emailLockedHelper, type LearnerEditDefaults } from "@/lib/learners";
import { browserTimeZone, timezoneOptions } from "@/lib/timezones";

// Spec 0008 AC-4 and AC-6, inside the form modal: empty with the browser's
// zone to add, the row's values to edit. The defaults are read once on open
// (the admin row edit rule). A locked email is shown disabled and sent as a
// hidden value, so the save sees it unchanged.
export function LearnerFields({
  defaults: initial,
}: {
  readonly defaults?: LearnerEditDefaults;
}) {
  const [defaults] = useState<LearnerEditDefaults>(
    () =>
      initial ?? {
        name: "",
        company: "",
        email: "",
        timezone: browserTimeZone(),
        emailEditable: true,
      },
  );
  const zones = useMemo(
    () =>
      timezoneOptions(defaults.timezone).map((z) => ({
        value: z,
        label: z.replaceAll("_", " "),
      })),
    [defaults.timezone],
  );

  return (
    <>
      <Field path="name" label="Full name">
        <Input
          name="name"
          autoComplete="off"
          required
          maxLength={200}
          placeholder="e.g. Priya Shah"
          defaultValue={defaults.name}
        />
      </Field>
      <Field path="company" label="Company name">
        <Input
          name="company"
          autoComplete="off"
          required
          maxLength={200}
          placeholder="e.g. Concordia University"
          defaultValue={defaults.company}
        />
      </Field>
      <Field
        path="email"
        label="Email address"
        description={
          defaults.emailEditable ? undefined : emailLockedHelper(defaults.name)
        }
      >
        <Input
          name={defaults.emailEditable ? "email" : undefined}
          type="email"
          autoComplete="off"
          required
          maxLength={254}
          placeholder="name@company.com"
          defaultValue={defaults.email}
          disabled={!defaults.emailEditable}
        />
      </Field>
      {defaults.emailEditable ? null : (
        <input type="hidden" name="email" value={defaults.email} />
      )}
      <Field path="timezone" label="Timezone">
        <FormSelect
          name="timezone"
          options={zones}
          placeholder="Choose a timezone"
          defaultValue={defaults.timezone}
        />
      </Field>
    </>
  );
}
