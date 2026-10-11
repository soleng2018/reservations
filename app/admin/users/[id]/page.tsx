import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeftIcon } from "lucide-react";
import { z } from "zod";
import { PageBody } from "@/components/admin/page-body";
import { PageHeader } from "@/components/admin/page-header";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toneFor } from "@/lib/badge-tones";
import { formatDateTime } from "@/lib/format-time";
import { initials } from "@/lib/initials";
import { cancelledByLabel, learnerStatusLabel } from "@/lib/learners";
import { requireAdmin } from "@/server/auth/require";
import { db } from "@/server/db";
import { getLearnerDetail, type LearnerDetail } from "@/server/users/learners";

export const metadata: Metadata = { title: "User" };

const load = async (id: string): Promise<LearnerDetail> => {
  if (!z.uuid().safeParse(id).success) notFound();
  const found = await getLearnerDetail(db(), id);
  if (!found.ok) notFound();
  return found.value;
};

// Spec 0008 AC-2: one learner and every booking of theirs, newest first,
// in the admin's timezone. Reads only.
export default async function UserDetailPage(
  props: PageProps<"/admin/users/[id]">,
) {
  const { user: admin } = await requireAdmin();
  const { id } = await props.params;
  const { learner, bookings } = await load(id);
  const status = learnerStatusLabel(learner.status);
  const subtitle = [learner.company, learner.email]
    .filter((v) => v !== null)
    .join(" · ");

  return (
    <>
      <PageHeader
        title={learner.name}
        subtitle={subtitle}
        action={
          <Link
            href="/admin/users"
            className={buttonVariants({ variant: "outline" })}
          >
            <ArrowLeftIcon data-icon="inline-start" aria-hidden="true" />
            All users
          </Link>
        }
      />
      <PageBody>
        <section
          aria-label="Learner"
          className="flex flex-wrap items-center justify-between gap-5 rounded-xl border bg-card px-6.5 py-6 shadow-xs"
        >
          <div className="flex min-w-0 items-center gap-4">
            <div
              aria-hidden="true"
              className="flex size-13 shrink-0 items-center justify-center rounded-full bg-nile-cta text-lg font-bold text-primary-foreground"
            >
              {initials(learner.name)}
            </div>
            <div className="min-w-0">
              <p className="truncate text-[1.1875rem] font-semibold text-fg1">
                {learner.name}
              </p>
              <p className="mt-0.5 truncate text-sm text-fg2">{subtitle}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <Badge tone={toneFor(status)}>{status}</Badge>
          </div>
        </section>

        <section
          aria-labelledby="reservations-heading"
          className="rounded-xl border bg-card shadow-xs"
        >
          <h2
            id="reservations-heading"
            className="px-6 pt-5 pb-1.5 text-base font-bold text-fg1"
          >
            Reservations
          </h2>
          {bookings.length === 0 ? (
            <p className="px-5 py-12.5 text-center text-sm text-fg3">
              No reservations yet.
            </p>
          ) : (
            <Table className="min-w-160">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Status</TableHead>
                  <TableHead>Testbed</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Start</TableHead>
                  <TableHead>End</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {bookings.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell>
                      <Badge tone={toneFor(b.phase)}>{b.phase}</Badge>
                      {b.phase === "Cancelled" && b.cancelSource ? (
                        <span className="mt-1 block text-pill text-fg3">
                          {cancelledByLabel(b.cancelSource)}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-cell font-semibold text-fg1">
                      {b.testbedName}
                    </TableCell>
                    <TableCell className="text-fg2">{b.typeName}</TableCell>
                    <TableCell className="text-sub text-fg2">
                      {formatDateTime(b.startsAt, admin.timezone)}
                    </TableCell>
                    <TableCell className="text-sub text-fg2">
                      {formatDateTime(b.endsAt, admin.timezone)}
                    </TableCell>
                    <TableCell className="text-right" />
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <p className="border-t px-6 py-3.5 text-pill text-fg3">
            Times in {admin.timezone}.
          </p>
        </section>
      </PageBody>
    </>
  );
}
