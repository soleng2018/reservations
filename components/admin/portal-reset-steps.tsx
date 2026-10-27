import type { ReactNode } from "react";
import { ListChecksIcon, ShieldCheckIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import type { ResetRowView } from "@/lib/portal-reset/view";
import { cn } from "@/lib/utils";

// The reset list as text (spec 0022 AC-4): order number, feature name, a
// Disabled badge, what the step does in plain words, the guards that apply,
// and the note. Below the nav breakpoint each row is a stacked card
// (AC-15); from it, one ruled list in a single card. Edit mode adds a button
// column (`actions`) and the problems a Save found in a row (`problems`).
export function PortalResetSteps({
  rows,
  actions,
  problems,
  emptyDescription = "The starting list is loaded the first time the app is deployed.",
}: {
  readonly rows: readonly ResetRowView[];
  readonly actions?: (row: ResetRowView) => ReactNode;
  readonly problems?: (row: ResetRowView) => readonly string[];
  readonly emptyDescription?: string;
}) {
  if (rows.length === 0) {
    return (
      <Empty className="rounded-xl border border-solid bg-card shadow-xs">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ListChecksIcon aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>No reset steps yet</EmptyTitle>
          <EmptyDescription>{emptyDescription}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <ol
      aria-label="Reset steps, in the order a reset runs them"
      className="flex flex-col gap-3 nav:gap-0 nav:divide-y nav:overflow-hidden nav:rounded-xl nav:border nav:bg-card nav:shadow-xs"
    >
      {rows.map((row) => (
        <li
          key={row.id}
          className={cn(
            "grid gap-x-5 gap-y-3 rounded-xl border bg-card px-5 py-4 shadow-xs nav:rounded-none nav:border-0 nav:shadow-none",
            actions
              ? "nav:grid-cols-[2rem_15rem_minmax(0,1fr)_auto]"
              : "nav:grid-cols-[2rem_15rem_minmax(0,1fr)]",
          )}
        >
          <div className="flex min-w-0 items-start gap-3 nav:contents">
            <span
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-bg-inset text-sub font-semibold text-fg2"
              data-testid="step-number"
            >
              <span className="sr-only">Step </span>
              {row.position}
            </span>
            <div className="flex min-w-0 flex-col items-start gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-cell font-semibold text-fg1">
                  {row.featureName}
                </span>
                {row.enabled ? null : <Badge tone="neutral">Disabled</Badge>}
              </div>
              {row.note === null ? null : (
                <p className="text-xs break-words text-fg3">{row.note}</p>
              )}
            </div>
          </div>
          <div className="flex min-w-0 flex-col gap-2 nav:col-start-3">
            {row.invalid ? (
              <p role="alert" className="text-sub text-danger-strong">
                This step no longer reads as a valid step. A reset stops at it
                until it is fixed.
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {row.description.map((line, i) => (
                  <li key={i} className="text-sub break-words text-fg2">
                    {line}
                  </li>
                ))}
              </ul>
            )}
            {row.guardLines.map((line) => (
              <p
                key={line}
                className="flex items-start gap-1.5 text-xs text-fg3"
              >
                <ShieldCheckIcon
                  className="mt-0.5 size-3.5 shrink-0"
                  aria-hidden="true"
                />
                <span>{line}</span>
              </p>
            ))}
            {(problems?.(row) ?? []).length > 0 ? (
              <ul
                aria-label={`Problems in ${row.featureName}`}
                className="flex flex-col gap-1 text-xs text-danger-strong"
              >
                {(problems?.(row) ?? []).map((line) => (
                  <li key={line} className="break-words">
                    {line}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          {actions ? (
            <div className="flex items-start gap-2 nav:col-start-4 nav:row-start-1">
              {actions(row)}
            </div>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
