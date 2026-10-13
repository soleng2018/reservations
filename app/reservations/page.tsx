import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ResendSetPassword } from "@/components/auth/resend-set-password";
import { LearnerFrame } from "@/components/learner-frame";
import { ReservationCard } from "@/components/reservations/reservation-card";
import { Button, buttonVariants } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format-time";
import {
  cardActions,
  firstName,
  sortCards,
  zoneName,
} from "@/lib/manage-reservations";
import { currentSession, requireLearner } from "@/server/auth/require";
import { hasLiveBooking, learnerBookings } from "@/server/booking/manage";
import { db } from "@/server/db";
import { dbNow } from "@/server/db/bookings";
import { turnstileEnv } from "@/server/env";
import { signInWithSso } from "../auth/actions";

export const metadata: Metadata = { title: "Manage your reservation" };

// Public before sign in, the learner area after (spec 0003). Signed in admins
// belong in the console; the role decides the landing (AC-2).
export default async function ReservationsPage() {
  const current = await currentSession();
  if (current?.user.role === "admin") redirect("/admin");
  if (current?.user.status === "deactivated")
    redirect("/auth/error?reason=deactivated");

  if (!current)
    return (
      <LearnerFrame>
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="flex w-full max-w-sm flex-col gap-8 rounded-lg border bg-card p-8">
            <form action={signInWithSso} className="flex flex-col gap-6">
              <h1 className="text-xl font-semibold">
                Manage an existing reservation
              </h1>
              <p className="text-sm text-muted-foreground">
                Sign in with the account you set up from your booking email.
              </p>
              <Button type="submit">Sign in</Button>
            </form>
            <ResendSetPassword siteKey={turnstileEnv().TURNSTILE_SITE_KEY} />
          </div>
        </div>
      </LearnerFrame>
    );

  return (
    <LearnerFrame>
      <ReservationList />
    </LearnerFrame>
  );
}

// Spec 0011 AC-1, AC-2: every booking of the learner's, in their account
// zone. Reads only.
async function ReservationList() {
  const { user } = await requireLearner();
  const conn = db();
  const [rows, live, now] = await Promise.all([
    learnerBookings(conn, user.id),
    hasLiveBooking(conn, user.id),
    dbNow(conn),
  ]);
  const cards = sortCards(rows, now);
  const at = (d: Date) => formatDateTime(d, user.timezone);

  return (
    <div className="mx-auto w-full max-w-170 px-5 pt-12 pb-20">
      <h1 className="mb-1 text-[1.5rem] leading-tight font-semibold text-fg1">
        Welcome back, {firstName(user.name)}
      </h1>
      <p className="mb-6 text-cell text-fg2">
        Here&apos;s everything on your account.{" "}
        {live ? (
          <span className="text-fg3">
            You have an active reservation. Finish it before booking another.
          </span>
        ) : (
          <Link
            href="/book"
            className="rounded-sm font-semibold text-nile-blue hover:underline"
          >
            Reserve another lab →
          </Link>
        )}
      </p>

      {cards.length === 0 ? (
        <p className="rounded-xl border bg-card px-5 py-12.5 text-center text-sm text-fg3">
          No reservations yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-3.5">
          {cards.map((card) => {
            const actions = cardActions(card.phase, card.reschedulable);
            return (
              <ReservationCard
                key={card.id}
                testbedName={card.testbedName}
                phase={card.phase}
                typeName={card.typeName}
                start={at(card.startsAt)}
                end={at(card.endsAt)}
                note={
                  actions.cannotReschedule
                    ? "This lab type can't be rescheduled right now."
                    : undefined
                }
                actions={
                  actions.reschedule || actions.cancel ? (
                    <>
                      {actions.reschedule ? (
                        <Link
                          href={`/reservations/${card.id}/reschedule`}
                          className={buttonVariants({
                            variant: "outline",
                            size: "sm",
                          })}
                        >
                          Reschedule
                        </Link>
                      ) : null}
                      {actions.cancel ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-danger-strong hover:bg-crimson-100 hover:text-danger-strong"
                        >
                          Cancel reservation
                        </Button>
                      ) : null}
                    </>
                  ) : undefined
                }
              />
            );
          })}
        </ul>
      )}
      <p className="mt-4 text-pill text-fg3">
        Times in {zoneName(user.timezone)}.
      </p>
    </div>
  );
}
