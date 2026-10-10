"use client";

import { useId, useState, type ReactNode } from "react";
import { SearchIcon } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { filterRows, resultCount } from "@/lib/table-search";
import { cn } from "@/lib/utils";

export type DataTableColumn = {
  readonly key: string;
  readonly header: string;
  readonly align?: "left" | "right";
};

// Plain data only, built by a Server Component: `cells` are already
// rendered, `search` is the row's searchable columns joined by the page.
export type DataTableRow = {
  readonly id: string;
  readonly label: string;
  readonly search: string;
  readonly cells: Readonly<Record<string, ReactNode>>;
  readonly actions?: ReactNode;
};

// The searchable table card (spec 0005 AC-6). Typing filters the server
// rendered rows in the browser; a hidden live region states the count.
export function DataTable({
  columns,
  rows,
  searchPlaceholder,
  noun,
  defaultQuery = "",
}: {
  readonly columns: readonly DataTableColumn[];
  readonly rows: readonly DataTableRow[];
  readonly searchPlaceholder: string;
  readonly noun: { readonly one: string; readonly many: string };
  // Starts the search filled in (the gallery's no match state).
  readonly defaultQuery?: string;
}) {
  const searchId = useId();
  const [query, setQuery] = useState(defaultQuery);
  const [touched, setTouched] = useState(false);
  const shown = filterRows(rows, query);
  const hasActions = rows.some((r) => r.actions !== undefined);
  const right = (c: DataTableColumn) => c.align === "right" && "text-right";

  return (
    <section
      aria-label={noun.many}
      className="rounded-xl border bg-card shadow-xs"
    >
      <div className="border-b px-5 py-4">
        <div className="relative w-full max-w-80">
          <label htmlFor={searchId} className="sr-only">
            Search {noun.many}
          </label>
          <SearchIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-fg3"
          />
          <input
            id={searchId}
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setTouched(true);
            }}
            placeholder={searchPlaceholder}
            autoComplete="off"
            className="w-full rounded-full border border-input bg-cloud-mist py-2.25 pr-4 pl-10.25 text-sm text-fg1 transition-colors duration-120 outline-none placeholder:text-fg3 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/35"
          />
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="px-5 py-15 text-center text-sm text-fg3">
          No {noun.many} yet. Add one to get started.
        </p>
      ) : (
        <>
          <Table className="min-w-140">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                {columns.map((c) => (
                  <TableHead key={c.key} className={cn(right(c))}>
                    {c.header}
                  </TableHead>
                ))}
                {hasActions ? (
                  <TableHead className="text-right">Actions</TableHead>
                ) : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((row) => (
                <TableRow key={row.id}>
                  {columns.map((c) => (
                    <TableCell key={c.key} className={cn(right(c))}>
                      {row.cells[c.key]}
                    </TableCell>
                  ))}
                  {hasActions ? (
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        {row.actions}
                      </div>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {shown.length === 0 ? (
            <p className="px-5 py-15 text-center text-sm text-fg3">
              No {noun.many} match your search.
            </p>
          ) : null}
        </>
      )}

      <p role="status" aria-live="polite" className="sr-only">
        {touched ? resultCount(shown.length) : ""}
      </p>
    </section>
  );
}
