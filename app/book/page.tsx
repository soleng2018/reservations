import type { Metadata } from "next";
import { connection } from "next/server";
import { BookForm } from "@/components/book/book-form";
import { LearnerFrame } from "@/components/learner-frame";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { bookableTypes } from "@/server/booking/availability";
import { db } from "@/server/db";
import { turnstileEnv } from "@/server/env";

// noindex until feature 11 decides on SEO (spec 0004 security model).
export const metadata: Metadata = {
  title: "Book a lab",
  robots: { index: false, follow: false },
};

// The guest booking tracer (spec 0004 AC-3). Public; no link to the admin
// URL anywhere in the flow (AC-13).
export default async function BookPage() {
  await connection(); // the type list is live, never prerendered
  const types = await bookableTypes(db());

  return (
    <LearnerFrame>
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 p-6 sm:p-10">
        <header className="flex flex-col gap-2">
          <p className="text-sm font-medium text-muted-foreground">
            Nile Hands-On Lab
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">
            Reserve a remote lab
          </h1>
          <p className="text-muted-foreground">
            Tell us who you are, pick a lab type and a start time, and
            we&apos;ll hold a testbed for you.
          </p>
        </header>
        <Card>
          <CardHeader>
            <CardTitle>Your details</CardTitle>
            <CardDescription>
              Already booked?{" "}
              <a href="/reservations" className="underline">
                Manage an existing reservation
              </a>
              .
            </CardDescription>
          </CardHeader>
          <CardContent>
            {types.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No labs are open for booking right now. Please check back soon.
              </p>
            ) : (
              <BookForm
                types={types.map((t) => ({ value: t.id, label: t.name }))}
                siteKey={turnstileEnv().TURNSTILE_SITE_KEY}
              />
            )}
          </CardContent>
        </Card>
      </div>
    </LearnerFrame>
  );
}
