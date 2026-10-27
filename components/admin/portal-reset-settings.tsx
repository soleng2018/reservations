import { MailWarningIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { PortalResetMode } from "@/lib/db-enums";
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
