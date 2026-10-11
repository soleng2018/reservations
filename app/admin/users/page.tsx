import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";
import { DataTable } from "@/components/admin/data-table";
import { PageBody } from "@/components/admin/page-body";
import { PageHeader } from "@/components/admin/page-header";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { toneFor } from "@/lib/badge-tones";
import {
  learnerSearchText,
  learnerStatusLabel,
  reservationCountLabel,
} from "@/lib/learners";
import { requireAdmin } from "@/server/auth/require";
import { db } from "@/server/db";
import { listLearnersForAdmin } from "@/server/users/learners";

export const metadata: Metadata = { title: "Users" };

// Spec 0008 AC-1: every learner with an Authentik account, any status.
// Admin accounts live only in Authentik and never appear here; there is no
// delete, only deactivate (on the detail page).
export default async function UsersPage() {
  await requireAdmin();
  const learners = await listLearnersForAdmin(db());

  const rows = learners.map((u) => {
    const status = learnerStatusLabel(u.status);
    const href = `/admin/users/${u.id}`;
    return {
      id: u.id,
      label: u.name,
      search: learnerSearchText(u),
      cells: {
        name: (
          <Link
            href={href}
            className="text-cell font-semibold text-fg1 underline-offset-4 hover:text-nile-blue hover:underline"
          >
            {u.name}
          </Link>
        ),
        company: u.company ?? (
          <>
            <span aria-hidden="true">—</span>
            <span className="sr-only">None</span>
          </>
        ),
        email: <span className="text-fg2">{u.email}</span>,
        reservations: reservationCountLabel(u.reservationCount),
        status: <Badge tone={toneFor(status)}>{status}</Badge>,
      },
      actions: (
        <Link
          href={href}
          aria-label={`View ${u.name}`}
          className={buttonVariants({ variant: "outline", size: "icon" })}
        >
          <ArrowRightIcon aria-hidden="true" />
        </Link>
      ),
    };
  });

  return (
    <>
      <PageHeader section="users" />
      <PageBody>
        <DataTable
          columns={[
            { key: "name", header: "Full name" },
            { key: "company", header: "Company" },
            { key: "email", header: "Email" },
            { key: "reservations", header: "Reservations" },
            { key: "status", header: "Status" },
          ]}
          rows={rows}
          noun={{ one: "user", many: "users" }}
          searchPlaceholder="Search by name, company, or email…"
        />
      </PageBody>
    </>
  );
}
