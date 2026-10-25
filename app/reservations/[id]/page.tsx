import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LearnerFrame } from "@/components/learner-frame";
import { LabAccessCard } from "@/components/reservations/lab-access-card";
import { Badge } from "@/components/ui/badge";
import { toneFor } from "@/lib/badge-tones";
import { bookingPhase } from "@/lib/booking-phase";
import { formatDateTime } from "@/lib/format-time";
import { labAccessView, labCardRows } from "@/lib/lab-access";
import { requireLearner } from "@/server/auth/require";
import { ownLabAccess } from "@/server/booking/lab-access";
import { db } from "@/server/db";
import { dbNow } from "@/server/db/bookings";

// noindex through the root layout's default. Dynamic: requireLearner() reads
// cookies, so never add generateStaticParams or a cache directive here.
export const metadata: Metadata = { title: "Lab access" };

// Spec 0012 AC-7, AC-8: one of the learner's own bookings with its lab
// links. Every miss (bad id, another learner's, cancelled, provisioning) is
// notFound(). A Past booking's card gets labels only, so its URLs never
// reach the browser.
export default async function LabAccessPage(
  props: PageProps<"/reservations/[id]">,
) {
  const { user } = await requireLearner();
  const { id } = await props.params;
  const conn = db();
  const found = await ownLabAccess(conn, user.id, id);
  if (found.kind === "missing") notFound();
  const { access } = found;
  const phase = bookingPhase(access, await dbNow(conn));
  const view = labAccessView(phase);
  const rows = [
    ["Lab type", access.typeName],
    ["Starts", formatDateTime(access.startsAt, user.timezone)],
    ["Ends", formatDateTime(access.endsAt, user.timezone)],
  ] as const;

  return (
    <LearnerFrame>
      <div className="mx-auto w-full max-w-140 px-5 pt-12 pb-20">
        <Link
          href="/reservations"
          className="mb-4.5 inline-block rounded-sm text-sub font-semibold text-nile-blue hover:underline"
        >
          <span aria-hidden="true">← </span>All reservations
        </Link>
        <div className="mb-5.5 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-[1.375rem] leading-tight font-semibold wrap-anywhere text-fg1">
            {access.testbedName}
          </h1>
          <Badge tone={toneFor(phase)}>{phase}</Badge>
        </div>
        <dl className="mb-5 flex flex-col gap-3 rounded-2xl border bg-card p-6 text-sm shadow-xs">
          {rows.map(([term, value]) => (
            <div key={term} className="flex flex-wrap justify-between gap-x-4">
              <dt className="text-fg3">{term}</dt>
              <dd className="min-w-0 text-right font-bold wrap-anywhere text-fg1">
                {value}
              </dd>
            </div>
          ))}
        </dl>
        <LabAccessCard
          variant="detail"
          note={view.note}
          rows={labCardRows(access.links, view)}
          testbedName={access.testbedName}
          nileLogin={access.links.nileLogin}
        />
      </div>
    </LearnerFrame>
  );
}
