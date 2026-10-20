"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { ChevronDownIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";
import type { AuditRow as AuditRowData } from "@/lib/audit-log";
import { cn } from "@/lib/utils";

export const AUDIT_COLUMNS = 6;

const link =
  "underline-offset-4 hover:text-nile-blue hover:underline focus-visible:text-nile-blue";

// Spec 0016 AC-2: one log entry, for the Audit Log and the user detail
// History section alike. Every value arrives as a plain string, formatted on
// the server; the only state is the details disclosure (AC-8).
export function AuditRow({ row }: { readonly row: AuditRowData }) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const { actor, action, target } = row;

  return (
    <>
      <TableRow>
        <TableCell className="w-12 pr-0 align-top">
          {row.details.length > 0 ? (
            <Button
              variant="ghost"
              size="icon"
              aria-expanded={open}
              aria-controls={detailsId}
              aria-label={`Details for ${action.label}, ${row.time}`}
              onClick={() => setOpen((o) => !o)}
            >
              <ChevronDownIcon
                aria-hidden="true"
                className={cn(
                  "transition-transform duration-120 ease-nile",
                  open && "rotate-180",
                )}
              />
            </Button>
          ) : null}
        </TableCell>
        <TableCell className="min-w-36 align-top text-sub whitespace-normal text-fg2">
          {row.time}
        </TableCell>
        <TableCell className="min-w-36 align-top whitespace-normal">
          <span className="flex flex-wrap items-center gap-1.5">
            {actor.role === "learner" && actor.userId ? (
              <Link
                href={`/admin/users/${actor.userId}`}
                className={cn("font-semibold text-fg1", link)}
              >
                {actor.label}
              </Link>
            ) : (
              <span
                className={cn(
                  actor.userId ? "font-semibold text-fg1" : "text-fg2",
                )}
              >
                {actor.label}
              </span>
            )}
            {actor.role ? (
              <Badge tone={actor.role === "admin" ? "accent" : "neutral"}>
                {actor.role === "admin" ? "Admin" : "Learner"}
              </Badge>
            ) : null}
          </span>
        </TableCell>
        <TableCell className="min-w-40 align-top whitespace-normal">
          <span className="block font-semibold text-fg1">{action.label}</span>
          {action.area ? (
            <span className="mt-0.5 block text-pill text-fg3">
              {action.area}
            </span>
          ) : null}
        </TableCell>
        <TableCell className="min-w-44 align-top whitespace-normal">
          <span className="flex flex-wrap items-center gap-1.5">
            <Link href={target.href} className={cn("text-fg1", link)}>
              {target.label}
            </Link>
            {target.deleted ? <Badge tone="neutral">Deleted</Badge> : null}
          </span>
        </TableCell>
        <TableCell className="min-w-56 align-top whitespace-normal">
          {row.summary}
        </TableCell>
      </TableRow>
      {row.details.length > 0 ? (
        <TableRow
          id={detailsId}
          hidden={!open}
          className="bg-cloud-mist hover:bg-cloud-mist"
        >
          <TableCell colSpan={AUDIT_COLUMNS} className="whitespace-normal">
            <dl className="grid gap-x-6 gap-y-1.5 sm:grid-cols-[max-content_1fr]">
              {row.details.map((d, i) => (
                <div key={`${i}-${d.label}`} className="contents">
                  <dt className="text-sub font-semibold text-fg2">{d.label}</dt>
                  <dd className="text-sub break-words text-fg1">{d.text}</dd>
                </div>
              ))}
            </dl>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}
