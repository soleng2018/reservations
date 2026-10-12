import { cn } from "@/lib/utils";
import { StepHeading } from "./step-heading";

export type ConfirmRow = {
  readonly label: string;
  readonly value: string;
  readonly accent?: boolean; // Nile Blue, for the new times
};

export type ConfirmSummary = {
  readonly eyebrow: string;
  readonly title: string;
  readonly who: readonly ConfirmRow[]; // above the divider
  readonly when: readonly ConfirmRow[]; // below it
};

// The Step 3 summary card (spec 0010 AC-7). A plain summary object, so
// feature 13's reschedule reuses it with its own rows and labels. The
// actions sit outside it, in the flow.
export function ConfirmStep({ summary }: { readonly summary: ConfirmSummary }) {
  return (
    <>
      <StepHeading eyebrow={summary.eyebrow} title={summary.title} />
      <div className="flex flex-col gap-3.5 rounded-2xl border bg-card p-7 text-cell shadow-xs max-sm:p-5">
        <Rows rows={summary.who} />
        <hr className="my-1 border-border" />
        <Rows rows={summary.when} />
      </div>
    </>
  );
}

function Rows({ rows }: { readonly rows: readonly ConfirmRow[] }) {
  return (
    <dl className="flex flex-col gap-3.5">
      {rows.map((row) => (
        <div
          key={row.label}
          className="flex flex-wrap justify-between gap-x-4 gap-y-0.5"
        >
          <dt className="text-fg3">{row.label}</dt>
          <dd
            className={cn(
              "min-w-0 text-right font-bold wrap-anywhere",
              row.accent ? "text-nile-blue" : "text-fg1",
            )}
          >
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
