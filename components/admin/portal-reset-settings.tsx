import { MailWarningIcon } from "lucide-react";
import { Field } from "@/components/field";
import { FormSelect } from "@/components/form-select";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { PortalResetMode } from "@/lib/db-enums";
import {
  MODE_HELP,
  MODE_LABEL,
  MODE_TONE,
  NO_EMAIL_WARNING,
} from "@/lib/portal-reset/mode";

// The abort email, the mode, and who saved last, as text (spec 0022 AC-4,
// AC-10). Edit mode swaps the two values for fields.
export function PortalResetSettings({
  abortEmail,
  mode,
  lastSaved,
}: {
  readonly abortEmail: string | null;
  readonly mode: PortalResetMode;
  // "Maria on 27 Oct 2026, 1:19 PM", or null before the first Save.
  readonly lastSaved: string | null;
}) {
  return (
    <section
      aria-label="Reset settings"
      className="grid gap-5 rounded-xl border bg-card px-5 py-4 shadow-xs nav:grid-cols-2"
    >
      <dl className="contents">
        <div className="flex min-w-0 flex-col gap-1.5">
          <dt className="text-th font-semibold tracking-wide text-fg3 uppercase">
            Abort email
          </dt>
          <dd className="text-cell break-all text-fg1">
            {abortEmail ?? (
              <span className="flex items-start gap-1.5 text-sub text-fg2">
                <MailWarningIcon
                  className="mt-0.5 size-4 shrink-0"
                  aria-hidden="true"
                />
                {NO_EMAIL_WARNING}
              </span>
            )}
          </dd>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <dt className="text-th font-semibold tracking-wide text-fg3 uppercase">
            Mode
          </dt>
          <dd className="flex flex-wrap items-center gap-2.5">
            <Badge tone={MODE_TONE[mode]}>{MODE_LABEL[mode]}</Badge>
            <span className="text-sub text-fg2">{MODE_HELP[mode]}</span>
          </dd>
        </div>
      </dl>
      {lastSaved === null ? null : (
        <p className="text-xs text-fg3 nav:col-span-2">
          Last saved by {lastSaved}
        </p>
      )}
    </section>
  );
}

const MODE_OPTIONS = PortalResetMode.options.map((value) => ({
  value,
  label: MODE_LABEL[value],
}));

// The same two settings while editing (spec 0022 AC-5, AC-22). Choosing
// live is the page's to confirm, so this only reports the choice.
export function PortalResetSettingsFields({
  abortEmail,
  mode,
  lastSaved,
  errors,
  disabled,
  onEmail,
  onMode,
}: {
  readonly abortEmail: string;
  readonly mode: PortalResetMode;
  readonly lastSaved: string | null;
  readonly errors: { readonly abortEmail?: string; readonly mode?: string };
  readonly disabled: boolean;
  readonly onEmail: (email: string) => void;
  readonly onMode: (mode: PortalResetMode) => void;
}) {
  return (
    <section
      aria-label="Reset settings"
      className="grid gap-5 rounded-xl border bg-card px-5 py-4 shadow-xs nav:grid-cols-2"
    >
      <div className="flex min-w-0 flex-col gap-2">
        <Field
          path="abortEmail"
          label="Abort email"
          error={errors.abortEmail}
          description="Told when a reset is aborted or does not go through."
        >
          <Input
            type="email"
            value={abortEmail}
            onChange={(e) => onEmail(e.target.value)}
            disabled={disabled}
            maxLength={254}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        {abortEmail.trim() === "" ? (
          <p className="flex items-start gap-1.5 text-sub text-fg2">
            <MailWarningIcon
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            {NO_EMAIL_WARNING}
          </p>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <Field
          path="mode"
          label="Mode"
          error={errors.mode}
          description={MODE_HELP[mode]}
        >
          <FormSelect
            name="mode"
            options={MODE_OPTIONS}
            placeholder="Choose a mode"
            value={mode}
            disabled={disabled}
            onValueChange={(next) => {
              const parsed = PortalResetMode.safeParse(next);
              if (parsed.success) onMode(parsed.data);
            }}
          />
        </Field>
      </div>
      {lastSaved === null ? null : (
        <p className="text-xs text-fg3 nav:col-span-2">
          Last saved by {lastSaved}
        </p>
      )}
    </section>
  );
}
