import type { Metadata } from "next";
import { AUDIT_COLUMNS, AuditRow } from "@/components/admin/audit-row";
import { PageBody } from "@/components/admin/page-body";
import { PageHeader } from "@/components/admin/page-header";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requireAdmin } from "@/server/auth/require";
import { listAuditEvents } from "@/server/audit-log";
import { db } from "@/server/db";

export const metadata: Metadata = { title: "Audit Log" };

// Spec 0016: every entry, newest first, for every admin. Read only: no
// Server Action, and opening it writes nothing.
export default async function AuditLogPage() {
  const { user: admin } = await requireAdmin();
  const page = await listAuditEvents(db(), admin.timezone);

  return (
    <>
      <PageHeader section="audit-log" />
      <PageBody>
        <section
          aria-label="Audit entries"
          className="rounded-xl border bg-card shadow-xs"
        >
          <Table className="min-w-240" region="Audit entries">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>When</TableHead>
                <TableHead>Who</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Summary</TableHead>
                <TableHead>
                  <span className="sr-only">Details</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.rows.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell
                    colSpan={AUDIT_COLUMNS}
                    className="py-15 text-center text-fg3"
                  >
                    No audit entries yet.
                  </TableCell>
                </TableRow>
              ) : (
                page.rows.map((row) => <AuditRow key={row.id} row={row} />)
              )}
            </TableBody>
          </Table>
          <p className="border-t px-6 py-3.5 text-pill text-fg3">
            Times in {admin.timezone}.
          </p>
        </section>
      </PageBody>
    </>
  );
}
