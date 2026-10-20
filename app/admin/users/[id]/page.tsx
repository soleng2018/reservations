import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeftIcon } from "lucide-react";
import { z } from "zod";
import { AuditRow } from "@/components/admin/audit-row";
import { FormDialog } from "@/components/admin/form-dialog";
import { HistoryLink } from "@/components/admin/history-link";
import { LearnerFields } from "@/components/admin/learner-fields";
import { BookingCancelButton } from "@/components/admin/booking-cancel-button";
import {
  DeactivateLearnerButton,
  ReactivateLearnerButton,
  ResendSetPasswordButton,
} from "@/components/admin/learner-status-actions";
import { PageBody } from "@/components/admin/page-body";
import { PageHeader } from "@/components/admin/page-header";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  auditHref,
  targetHistoryHref,
  type AuditRow as AuditRowData,
} from "@/lib/audit-log";
import { toneFor } from "@/lib/badge-tones";
import {
  EMAIL_KIND_LABEL,
  EMAIL_NOT_SET_UP,
  EMAIL_STATUS_LABEL,
  emailErrorLine,
} from "@/lib/email-log";
import { formatDateTime } from "@/lib/format-time";
import { initials } from "@/lib/initials";
import {
  cancelledByLabel,
  editDefaults,
  learnerStatusLabel,
} from "@/lib/learners";
import { cn } from "@/lib/utils";
import { learnerHistory } from "@/server/audit-log";
import { requireAdmin } from "@/server/auth/require";
import { googleConfigured } from "@/server/catalog/api-keys";
import { db } from "@/server/db";
import { listUserEmails, type EmailRow } from "@/server/email/messages";
import { getLearnerDetail, type LearnerDetail } from "@/server/users/learners";
import {
  cancelBookingAdminAction,
  checkDeactivate,
  deactivateLearnerAction,
  reactivateLearnerAction,
  resendSetPasswordAdminAction,
  updateLearnerAction,
} from "../actions";

export const metadata: Metadata = { title: "User" };

// Spec 0016 AC-10: the learner's newest entries on their page.
const HISTORY_LIMIT = 20;

const load = async (id: string): Promise<LearnerDetail> => {
  if (!z.uuid().safeParse(id).success) notFound();
  const found = await getLearnerDetail(db(), id);
  if (!found.ok) notFound();
  return found.value;
};

// Spec 0008 AC-2: one learner and every booking of theirs, newest first,
// in the admin's timezone. Reads only. Spec 0013 AC-21 adds their emails.
export default async function UserDetailPage(
  props: PageProps<"/admin/users/[id]">,
) {
  const { user: admin } = await requireAdmin();
  const { id } = await props.params;
  const { learner, bookings } = await load(id);
  const [emails, emailReady, history] = await Promise.all([
    listUserEmails(db(), learner.id),
    googleConfigured(db()),
    learnerHistory(db(), learner.id, admin.timezone, HISTORY_LIMIT),
  ]);
  const status = learnerStatusLabel(learner.status);
  // AC-7: only an active learner who has not set a password yet.
  const canResend = learner.status === "active" && learner.setPasswordPending;
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
            className={cn(buttonVariants({ variant: "outline" }))}
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
            <FormDialog
              trigger={<Button variant="outline">Edit</Button>}
              title="Edit User"
              action={updateLearnerAction.bind(null, learner.id)}
            >
              <LearnerFields defaults={editDefaults(learner)} />
            </FormDialog>
            {learner.status === "active" ? (
              <DeactivateLearnerButton
                name={learner.name}
                check={checkDeactivate.bind(null, learner.id)}
                action={deactivateLearnerAction.bind(null, learner.id)}
              />
            ) : (
              <ReactivateLearnerButton
                name={learner.name}
                action={reactivateLearnerAction.bind(null, learner.id)}
              />
            )}
            {canResend ? (
              <ResendSetPasswordButton
                action={resendSetPasswordAdminAction.bind(null, learner.id)}
              />
            ) : null}
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
            <Table className="min-w-160" region="Reservations">
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
                    <TableCell className="text-cell font-semibold whitespace-normal text-fg1">
                      {b.testbedName}
                    </TableCell>
                    <TableCell className="whitespace-normal text-fg2">
                      {b.typeName}
                    </TableCell>
                    <TableCell className="min-w-36 text-sub whitespace-normal text-fg2">
                      {formatDateTime(b.startsAt, admin.timezone)}
                    </TableCell>
                    <TableCell className="min-w-36 text-sub whitespace-normal text-fg2">
                      {formatDateTime(b.endsAt, admin.timezone)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <HistoryLink
                          href={targetHistoryHref("booking", b.id)}
                          name={`${b.testbedName}, ${formatDateTime(b.startsAt, admin.timezone)}`}
                        />
                        {b.phase === "Upcoming" || b.phase === "Current" ? (
                          <BookingCancelButton
                            testbed={b.testbedName}
                            start={formatDateTime(b.startsAt, admin.timezone)}
                            end={formatDateTime(b.endsAt, admin.timezone)}
                            current={b.phase === "Current"}
                            action={cancelBookingAdminAction.bind(
                              null,
                              b.id,
                              b.version,
                            )}
                          />
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <p className="border-t px-6 py-3.5 text-pill text-fg3">
            Times in {admin.timezone}.
          </p>
        </section>

        <EmailsSection
          emails={emails}
          configured={emailReady}
          timezone={admin.timezone}
        />

        <HistorySection
          learnerId={learner.id}
          rows={history}
          timezone={admin.timezone}
        />
      </PageBody>
    </>
  );
}

// Spec 0013 AC-21: the learner's last 50 emails, newest first, so an admin
// can answer "I never got anything".
function EmailsSection({
  emails,
  configured,
  timezone,
}: {
  readonly emails: readonly EmailRow[];
  readonly configured: boolean;
  readonly timezone: string;
}) {
  return (
    <section
      aria-labelledby="emails-heading"
      className="rounded-xl border bg-card shadow-xs"
    >
      <h2
        id="emails-heading"
        className="px-6 pt-5 pb-1.5 text-base font-bold text-fg1"
      >
        Emails
      </h2>
      {configured ? null : (
        <p
          role="note"
          className="mx-6 mt-2 mb-1 rounded-lg bg-cloud-mist px-4 py-3 text-sm text-fg2"
        >
          {EMAIL_NOT_SET_UP}
        </p>
      )}
      {emails.length === 0 ? (
        <p className="px-5 py-12.5 text-center text-sm text-fg3">
          No emails yet.
        </p>
      ) : (
        <Table className="min-w-160" region="Emails">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>When</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Subject</TableHead>
              <TableHead>To</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {emails.map((e) => {
              const status = EMAIL_STATUS_LABEL[e.status];
              const error = emailErrorLine(e.status, e.lastError);
              return (
                <TableRow key={e.id}>
                  <TableCell className="min-w-36 text-sub whitespace-normal text-fg2">
                    {formatDateTime(e.createdAt, timezone)}
                  </TableCell>
                  <TableCell className="text-fg2">
                    {EMAIL_KIND_LABEL[e.kind]}
                  </TableCell>
                  <TableCell className="min-w-56 text-cell whitespace-normal text-fg1">
                    {e.subject}
                  </TableCell>
                  <TableCell className="text-sub break-all whitespace-normal text-fg2">
                    {e.to}
                  </TableCell>
                  <TableCell className="min-w-40 whitespace-normal">
                    <Badge tone={toneFor(status)}>{status}</Badge>
                    {error ? (
                      <span className="mt-1 block text-pill text-fg3">
                        {error}
                      </span>
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      <p className="border-t px-6 py-3.5 text-pill text-fg3">
        Times in {timezone}.
      </p>
    </section>
  );
}

// Spec 0016 AC-10: the learner's 20 newest audit entries, by the Audit
// Log's learner rule, with a link to all of them.
function HistorySection({
  learnerId,
  rows,
  timezone,
}: {
  readonly learnerId: string;
  readonly rows: readonly AuditRowData[];
  readonly timezone: string;
}) {
  return (
    <section
      aria-labelledby="history-heading"
      className="rounded-xl border bg-card shadow-xs"
    >
      <div className="flex items-center justify-between gap-3 px-6 pt-5 pb-1.5">
        <h2 id="history-heading" className="text-base font-bold text-fg1">
          History
        </h2>
        <Link
          href={auditHref({ learner: learnerId })}
          className="text-sm font-semibold text-nile-blue underline-offset-4 hover:underline"
        >
          See all
        </Link>
      </div>
      {rows.length === 0 ? (
        <p className="px-5 py-12.5 text-center text-sm text-fg3">
          No history yet.
        </p>
      ) : (
        <Table className="min-w-240" region="History">
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
            {rows.map((row) => (
              <AuditRow key={row.id} row={row} />
            ))}
          </TableBody>
        </Table>
      )}
      <p className="border-t px-6 py-3.5 text-pill text-fg3">
        Times in {timezone}.
      </p>
    </section>
  );
}
