import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRightIcon, PencilIcon, PlusIcon } from "lucide-react";
import { DataTable } from "@/components/admin/data-table";
import { FormDialog } from "@/components/admin/form-dialog";
import { LearnerFields } from "@/components/admin/learner-fields";
import { PageBody } from "@/components/admin/page-body";
import { PageHeader } from "@/components/admin/page-header";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { toneFor } from "@/lib/badge-tones";
import {
  editDefaults,
  learnerSearchText,
  learnerStatusLabel,
  reservationCountLabel,
} from "@/lib/learners";
import { requireAdmin } from "@/server/auth/require";
import { db } from "@/server/db";
import { listLearnersForAdmin } from "@/server/users/learners";
import { createLearnerAction, updateLearnerAction } from "./actions";

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
        <>
          <Link
            href={href}
            aria-label={`View ${u.name}`}
            className={buttonVariants({ variant: "outline", size: "icon" })}
          >
            <ArrowRightIcon aria-hidden="true" />
          </Link>
          <FormDialog
            trigger={
              <Button
                variant="outline"
                size="icon"
                aria-label={`Edit ${u.name}`}
              >
                <PencilIcon aria-hidden="true" />
              </Button>
            }
            title="Edit User"
            action={updateLearnerAction.bind(null, u.id)}
          >
            <LearnerFields defaults={editDefaults(u)} />
          </FormDialog>
        </>
      ),
    };
  });

  return (
    <>
      <PageHeader
        section="users"
        action={
          <FormDialog
            trigger={
              <Button>
                <PlusIcon data-icon="inline-start" aria-hidden="true" />
                Add user
              </Button>
            }
            title="Add User"
            action={createLearnerAction}
          >
            <LearnerFields />
          </FormDialog>
        }
      />
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
