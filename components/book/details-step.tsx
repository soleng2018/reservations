"use client";

import Link from "next/link";
import type { FormEvent } from "react";
import { AlertCircleIcon } from "lucide-react";
import type { DetailsFields } from "@/app/book/actions";
import { Field } from "@/components/field";
import { FormSelect, type SelectOption } from "@/components/form-select";
import { TimezoneCombobox } from "@/components/timezone-combobox";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { BOOK_ERRORS } from "@/lib/booking-input";
import type { Account, DetailsNotice } from "@/lib/booking-flow";
import type { FieldErrors } from "@/lib/form-errors";
import { zoneLabel } from "@/lib/timezones";
import { StepHeading } from "./step-heading";
import { cn } from "@/lib/utils";

// Step 1, "Tell us about you" (spec 0010 AC-1, AC-3). For a signed in
// learner (spec 0011 AC-13) the account shows read only and the lab type is
// the only input.
export function DetailsStep({
  types,
  zones,
  account,
  form,
  fields,
  notice,
  checking,
  onEdit,
  onContinue,
}: {
  readonly types: readonly SelectOption[];
  readonly zones: readonly string[];
  readonly account?: Account;
  readonly form: DetailsFields;
  readonly fields: FieldErrors;
  readonly notice: DetailsNotice;
  readonly checking: boolean;
  readonly onEdit: (field: keyof DetailsFields, value: string) => void;
  readonly onContinue: () => void;
}) {
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!checking) onContinue();
  };
  const typeError =
    fields.testbedTypeId ??
    (notice.kind === "type_unavailable"
      ? BOOK_ERRORS.type_unavailable
      : undefined);

  return (
    <div className="mx-auto w-full max-w-140 px-5 pt-12 pb-20">
      <StepHeading eyebrow="Step 1 of 3" title="Tell us about you" />
      <form
        onSubmit={submit}
        noValidate
        className="flex flex-col gap-4 rounded-2xl border bg-card p-7 shadow-xs max-sm:p-5"
      >
        {types.length === 0 ? (
          <p className="text-cell text-fg2">
            No labs are open for booking right now. Please check back soon.
          </p>
        ) : (
          <>
            {account ? (
              <AccountSummary account={account} />
            ) : (
              <>
                <Field path="name" label="Full name" error={fields.name}>
                  <Input
                    name="name"
                    autoComplete="name"
                    placeholder="Jane Doe"
                    maxLength={200}
                    value={form.name}
                    onChange={(e) => onEdit("name", e.target.value)}
                  />
                </Field>
                <Field
                  path="company"
                  label="Company name"
                  error={fields.company}
                >
                  <Input
                    name="company"
                    autoComplete="organization"
                    placeholder="Acme University"
                    maxLength={200}
                    value={form.company}
                    onChange={(e) => onEdit("company", e.target.value)}
                  />
                </Field>
                <Field path="email" label="Email address" error={fields.email}>
                  <Input
                    name="email"
                    type="email"
                    autoComplete="email"
                    placeholder="jane@acme.edu"
                    maxLength={254}
                    value={form.email}
                    onChange={(e) => onEdit("email", e.target.value)}
                  />
                </Field>
              </>
            )}
            <Field path="testbedTypeId" label="Lab type" error={typeError}>
              <FormSelect
                name="testbedTypeId"
                options={types}
                placeholder="Select a lab type"
                value={form.testbedTypeId === "" ? null : form.testbedTypeId}
                onValueChange={(v) => onEdit("testbedTypeId", v)}
              />
            </Field>
            {account ? null : (
              <Field
                path="timezone"
                label="Your timezone"
                error={fields.timezone}
              >
                <TimezoneCombobox
                  name="timezone"
                  options={zones}
                  value={form.timezone}
                  onValueChange={(z) => onEdit("timezone", z)}
                />
              </Field>
            )}

            {notice.kind === "has_live_booking" ? (
              <Alert
                variant="destructive"
                className="rounded-lg border-0 bg-crimson-100 px-4 py-3.5"
              >
                <AlertTitle className="text-sub font-bold">
                  You already have an active reservation
                </AlertTitle>
                <AlertDescription className="text-[0.8125rem]">
                  Sign in to manage it.
                </AlertDescription>
                <Link
                  href="/reservations"
                  className={cn(
                    buttonVariants({
                      variant: "destructive",
                      size: "sm",
                      className: "mt-2.5 justify-self-start",
                    }),
                  )}
                >
                  Manage my reservations
                </Link>
              </Alert>
            ) : notice.kind === "signed_out" ? (
              <Alert variant="destructive">
                <AlertCircleIcon aria-hidden="true" />
                <AlertDescription>
                  {BOOK_ERRORS.signed_out}{" "}
                  <Link
                    href="/reservations"
                    className="font-semibold underline underline-offset-4"
                  >
                    Sign in
                  </Link>
                </AlertDescription>
              </Alert>
            ) : notice.kind === "alert" ? (
              <Alert variant="destructive">
                <AlertCircleIcon aria-hidden="true" />
                <AlertDescription>{notice.message}</AlertDescription>
              </Alert>
            ) : null}

            <div className="mt-1.5 flex gap-3">
              <Link
                href="/"
                className={cn(
                  buttonVariants({ variant: "outline", size: "lg" }),
                )}
              >
                Back
              </Link>
              <Button
                type="submit"
                size="lg"
                className="flex-1"
                disabled={checking}
              >
                {checking ? <Spinner data-icon="inline-start" /> : null}
                Continue
              </Button>
            </div>
          </>
        )}
      </form>
      {types.length === 0 ? (
        <div className="mt-5">
          <Link href="/" className={cn(buttonVariants({ variant: "outline" }))}>
            Back
          </Link>
        </div>
      ) : null}
    </div>
  );
}

// "Booking as <name>" with the stored company (when set), email, and zone.
function AccountSummary({ account }: { readonly account: Account }) {
  const rows = [
    ...(account.company === null ? [] : [["Company", account.company]]),
    ["Email", account.email],
    ["Timezone", zoneLabel(account.timezone, new Date())],
  ] as const;
  return (
    <section
      aria-labelledby="booking-as"
      className="rounded-lg bg-cloud-mist px-4.5 py-4"
    >
      <h2 id="booking-as" className="mb-2.5 text-cell text-fg2">
        Booking as{" "}
        <span className="font-bold wrap-anywhere text-fg1">{account.name}</span>
      </h2>
      <dl className="flex flex-col gap-1.5 text-[0.8125rem]">
        {rows.map(([term, value]) => (
          <div key={term} className="flex flex-wrap justify-between gap-x-4">
            <dt className="text-fg3">{term}</dt>
            <dd className="min-w-0 text-right font-semibold wrap-anywhere text-fg1">
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
