import { useId } from "react";
import { ExternalLinkIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { LabCardRows, LabRow } from "@/lib/lab-access";
import { cn } from "@/lib/utils";

// A booking's lab links as in the mock (spec 0012 AC-2, AC-7, AC-8): the
// small "Your lab access" card on the success screens, or the detail page's
// "Lab access" card with the testbed row. An ended card shows a plain
// "Ended" tag per row: no anchor, no URL, nothing focusable, never faded.
// Only useId, so it renders inside the client flows and on the server page.
export function LabAccessCard({
  variant,
  note,
  rows,
  testbedName,
}: {
  readonly variant: "success" | "detail";
  readonly note: string;
  readonly rows: LabCardRows;
  readonly testbedName?: string; // the detail page's "Testbed assigned" row
}) {
  const headingId = useId();
  const detail = variant === "detail";
  const row = cn(
    "flex flex-wrap items-center justify-between gap-x-2.5 gap-y-1",
    detail ? "rounded-md px-3 py-2.5" : "rounded-[0.5625rem] px-3 py-2",
  );
  const labelSize = detail ? "text-sub" : "text-[0.8125rem]";

  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        "border bg-card shadow-xs",
        detail ? "rounded-2xl p-6" : "mb-3 rounded-[0.875rem] px-4.5 py-4",
      )}
    >
      <h2
        id={headingId}
        className={cn(
          "font-bold text-fg1",
          detail ? "mb-1 text-[0.9375rem]" : "mb-1 text-sm",
        )}
      >
        {detail ? "Lab access" : "Your lab access"}
      </h2>
      <p
        className={cn(
          "text-[0.8125rem] text-fg2",
          detail ? "mb-3.5" : "mb-2.5",
        )}
      >
        {note}
      </p>
      <ul className={cn("flex flex-col", detail ? "gap-2.5" : "gap-1.75")}>
        {testbedName !== undefined ? (
          <li className={cn(row, "bg-nile-blue-050")}>
            <span className={cn(labelSize, "font-semibold text-fg1")}>
              Testbed assigned
            </span>
            <strong className={cn(labelSize, "wrap-anywhere text-nile-blue")}>
              {testbedName}
            </strong>
          </li>
        ) : null}
        {rows.kind === "active"
          ? rows.rows.map((r, i) => (
              <li key={i} className={cn(row, "bg-cloud-mist")}>
                <RowLabel row={r} size={labelSize} />
                <a
                  href={r.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(
                    "flex items-center gap-1.25 rounded-sm font-semibold text-nile-blue hover:underline",
                    detail ? "text-[0.8125rem]" : "text-pill",
                  )}
                >
                  Open
                  <span className="sr-only">
                    {` ${rowName(r)} (opens in a new tab)`}
                  </span>
                  <ExternalLinkIcon aria-hidden="true" className="size-3.25" />
                </a>
              </li>
            ))
          : rows.rows.map((r, i) => (
              <li key={i} className={cn(row, "bg-cloud-mist")}>
                <RowLabel row={r} size={labelSize} />
                <Badge tone="neutral">Ended</Badge>
              </li>
            ))}
      </ul>
    </section>
  );
}

const rowName = (r: LabRow) => (r.kind ? `${r.label} ${r.kind}` : r.label);

function RowLabel({
  row,
  size,
}: {
  readonly row: LabRow;
  readonly size: string;
}) {
  return (
    <span className={cn(size, "min-w-0 font-semibold wrap-anywhere text-fg1")}>
      {row.label}
      {row.kind ? (
        <span className="font-medium text-fg3"> · {row.kind}</span>
      ) : null}
    </span>
  );
}
