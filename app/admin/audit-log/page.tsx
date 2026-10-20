import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { AuditFilters } from "@/components/admin/audit-filters";
import { AuditRow } from "@/components/admin/audit-row";
import { PageBody } from "@/components/admin/page-body";
import { PageHeader } from "@/components/admin/page-header";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AUDIT_LOG_PATH,
  DROPPED_NOTICE,
  auditHref,
  hasFilters,
  parseAuditQuery,
} from "@/lib/audit-log";
import { cn } from "@/lib/utils";
import { requireAdmin } from "@/server/auth/require";
import { listAdmins, listAuditEvents } from "@/server/audit-log";
import { db } from "@/server/db";

export const metadata: Metadata = { title: "Audit Log" };

// Spec 0016: every entry, newest first, 50 a page, for every admin, with
// the filters in the URL. Read only: no Server Action, and opening it
// writes nothing.
export default async function AuditLogPage({
  searchParams,
}: PageProps<"/admin/audit-log">) {
  const { user: admin } = await requireAdmin();
  const { query, dropped } = parseAuditQuery(await searchParams);
  const [page, admins] = await Promise.all([
    listAuditEvents(db(), query, admin.timezone),
    listAdmins(db()),
  ]);
  const filtered = hasFilters(query);

  return (
    <>
      <PageHeader section="audit-log" />
      <PageBody>
        {dropped.length > 0 ? (
          <Alert role="status">
            <AlertDescription>{DROPPED_NOTICE}</AlertDescription>
          </Alert>
        ) : null}
        <AuditFilters key={auditHref(query)} query={query} admins={admins} />
        {page.chips.length > 0 ? (
          <div className="flex flex-col gap-2.5">
            <ul aria-label="History filters" className="flex flex-wrap gap-2">
              {page.chips.map((chip) => (
                <li
                  key={chip.filter}
                  className="inline-flex max-w-full items-center gap-1 rounded-full bg-nile-blue-100 py-1 pr-1 pl-3.5 text-sm font-semibold text-nile-blue"
                >
                  <span className="min-w-0 truncate">{chip.text}</span>
                  <Link
                    href={auditHref({ ...query, [chip.filter]: undefined })}
                    aria-label={`Remove filter: ${chip.text}`}
                    className="inline-flex size-7 shrink-0 items-center justify-center rounded-full hover:bg-nile-blue-050"
                  >
                    <XIcon aria-hidden="true" className="size-4" />
                  </Link>
                </li>
              ))}
            </ul>
            {page.bookingNoteUserId ? (
              <p className="text-sm text-fg2">
                Access removals for this booking are listed in{" "}
                <Link
                  href={auditHref({ learner: page.bookingNoteUserId })}
                  className="font-semibold text-nile-blue underline underline-offset-4"
                >
                  the learner&apos;s history
                </Link>
                .
              </p>
            ) : null}
          </div>
        ) : null}
        <section
          aria-label="Audit entries"
          className="rounded-xl border bg-card shadow-xs"
        >
          {page.rows.length > 0 ? (
            <Table className="min-w-240" region="Audit entries">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-12 pr-0">
                    <span className="sr-only">Details</span>
                  </TableHead>
                  <TableHead>When</TableHead>
                  <TableHead>Who</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Summary</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {page.rows.map((row) => (
                  <AuditRow key={row.id} row={row} />
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="px-5 py-15 text-center text-sm text-fg3">
              {filtered || query.cursor ? (
                <>
                  No entries match these filters.{" "}
                  <Link
                    href={AUDIT_LOG_PATH}
                    className="font-semibold text-nile-blue underline underline-offset-4"
                  >
                    Clear filters
                  </Link>
                </>
              ) : (
                "No audit entries yet."
              )}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t px-6 py-3.5">
            <p className="text-pill text-fg3">Times in {admin.timezone}.</p>
            {page.newer || page.older ? (
              <nav aria-label="Pages" className="flex gap-2.5">
                {page.newer ? (
                  <Link
                    href={auditHref(query, { after: page.newer })}
                    rel="prev"
                    className={cn(buttonVariants({ variant: "outline" }))}
                  >
                    <ChevronLeftIcon
                      data-icon="inline-start"
                      aria-hidden="true"
                    />
                    Newer
                  </Link>
                ) : null}
                {page.older ? (
                  <Link
                    href={auditHref(query, { before: page.older })}
                    rel="next"
                    className={cn(buttonVariants({ variant: "outline" }))}
                  >
                    Older
                    <ChevronRightIcon
                      data-icon="inline-end"
                      aria-hidden="true"
                    />
                  </Link>
                ) : null}
              </nav>
            ) : null}
          </div>
        </section>
      </PageBody>
    </>
  );
}
